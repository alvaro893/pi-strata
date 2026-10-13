import { spawn } from "node:child_process";
import type { ModelCost } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { StrataClient, type StrataErrorKind } from "./client.ts";
import {
  DEFAULT_MAX_TOKENS,
  FALLBACK_CTX,
  POLL_INTERVAL,
  PROVIDER_NAME,
  THINKING_LEVEL_MAP,
} from "./constants.ts";
import { StrataSettingsManager } from "./settings.ts";
import type {
  StrataConfigView,
  StrataHealth,
  StrataModelsResponse,
  StrataProps,
  StrataServerConfig,
  StrataStatusKind,
  StrataV1Status,
} from "./types.ts";

/** The chat member of Pi's provider-model union (the one a Strata model fills). */
type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

/** One model a Strata server serves (an alias is a model too: Strata answers to it). */
export interface StrataModel {
  id: string;
  name: string;
  /** Set on an alias: the id of the model it names. */
  aliasOf?: string;
}

/** Everything one round of reads told us about a server. */
interface Probe {
  health?: StrataHealth;
  status?: StrataV1Status;
  props?: StrataProps;
  models?: StrataModelsResponse;
  error?: { kind: StrataErrorKind; message: string };
}

/**
 * One Strata server.
 *
 * A Strata process serves exactly one model (its run config), so "several
 * models" means several servers - one per installed model, on its own port, or
 * one address in front of them (llama-swap). Each server becomes its own Pi
 * provider here, exactly like the llama.cpp extension does per router.
 */
export class StrataServer {
  readonly client: StrataClient;
  readonly providerId: string;
  readonly providerName: string;

  /** Ids with a load in flight; Strata has no loading state of its own. */
  private readonly loading = new Set<string>();
  /** Last load error per model id, shown as "failed" until a load succeeds. */
  private readonly failures = new Map<string, string>();

  private snapshot: Probe = {};

  constructor(
    readonly config: StrataServerConfig,
    apiKey: string,
    readonly settings: StrataSettingsManager,
  ) {
    this.client = new StrataClient(config.url, apiKey);
    this.providerId = StrataSettingsManager.providerId(config.url, config.id);
    this.providerName = `${PROVIDER_NAME} (${config.name ?? config.url})`;
  }

  get url(): string {
    return this.config.url;
  }

  /** Refresh the cached probe; never throws - the outcome is read through the status helpers. */
  async refresh(timeout: number): Promise<void> {
    const health = await this.client.health(timeout).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    if (!health.ok) {
      this.snapshot = {
        error: {
          kind: health.error.kind === "timeout" ? "timeout" : "unreachable",
          message: health.error.message,
        },
      };
      return;
    }

    // The model list is the source of truth for ids and aliases; /v1/status and
    // /props add the live detail. A 401 here means the server is up but the key
    // is missing or wrong, which is a distinct state from "unreachable".
    const [models, status, props] = await Promise.all([
      this.client.models(timeout).catch(() => undefined),
      this.client.status(timeout).catch(() => undefined),
      this.client.props(timeout).catch(() => undefined),
    ]);

    if (!models && !status && !props) {
      this.snapshot = {
        health: health.value,
        error: {
          kind: "unauthorized",
          message: `${this.url} needs an API key - run /login and pick ${this.providerName}`,
        },
      };
      return;
    }

    this.snapshot = { health: health.value, models, status, props };
  }

  get probeError(): Probe["error"] {
    return this.snapshot.error;
  }

  /** The model this server serves; aliases are listed after it. */
  get models(): StrataModel[] {
    const data = this.snapshot.models?.data ?? [];
    const primary = data.find((entry) => !entry.alias_of)?.id ?? this.snapshot.health?.model;
    if (!primary) return [];

    const aliases = new Set<string>(data.filter((entry) => entry.alias_of).map((entry) => entry.id));
    for (const alias of data.find((entry) => !entry.alias_of)?.aliases ?? []) aliases.add(alias);
    aliases.delete(primary);

    return [
      { id: primary, name: primary },
      ...[...aliases].map((id) => ({ id, name: id, aliasOf: primary })),
    ];
  }

  /** The primary model id (aliases share its state). */
  private primaryOf(model: StrataModel): string {
    return model.aliasOf ?? model.id;
  }

  private overrideFor(model: StrataModel) {
    return this.settings.findOverride(this.config.overrides, this.primaryOf(model));
  }

  /** Context window: server first, then the override, then a fallback. */
  contextWindow(model: StrataModel): number {
    const overridden = this.overrideFor(model)?.contextSize;
    if (overridden && overridden > 0) return overridden;

    const data = (this.snapshot.models?.data ?? []).find((entry) => entry.id === this.primaryOf(model));
    return (
      data?.meta?.n_ctx ??
      this.snapshot.status?.context?.native ??
      this.snapshot.health?.max_context ??
      this.snapshot.props?.default_generation_settings?.n_ctx ??
      FALLBACK_CTX
    );
  }

  maxTokens(model: StrataModel): number {
    const overridden = this.overrideFor(model)?.maxTokens;
    if (overridden && overridden > 0) return overridden;
    return Math.min(this.contextWindow(model), DEFAULT_MAX_TOKENS);
  }

  /** Input modalities: the override replaces detection. */
  capabilities(model: StrataModel): ("text" | "image")[] {
    const overridden = this.overrideFor(model)?.capabilities;
    if (overridden && overridden.length > 0) return overridden;

    const vision =
      this.snapshot.status?.vision?.enabled ??
      this.snapshot.health?.images ??
      this.snapshot.props?.modalities?.vision ??
      false;
    return vision ? ["text", "image"] : ["text"];
  }

  reasoning(model: StrataModel): boolean {
    return this.overrideFor(model)?.reasoning ?? true;
  }

  /** Whether the model is in memory right now. */
  isLoaded(): boolean {
    return this.snapshot.health?.loaded ?? this.snapshot.status?.loaded ?? false;
  }

  /** Whether a request would load it by itself (lazy start or idle-unload). */
  autoLoads(): boolean {
    return this.snapshot.status?.auto_load ?? this.snapshot.props?.models_autoload ?? false;
  }

  /** Live state of a model, as shown by the status icons. */
  statusOf(model: StrataModel): StrataStatusKind {
    const primary = this.primaryOf(model);
    if (this.loading.has(primary)) return "loading";
    if (this.snapshot.error)
      return this.snapshot.error.kind === "unauthorized" ? "unauthorized" : "unreachable";
    if (this.failures.has(primary)) return "failed";
    if (this.isLoaded()) return "loaded";
    return this.autoLoads() ? "sleeping" : "unloaded";
  }

  /** The last load failure of a model, if any. */
  failureOf(model: StrataModel): string | undefined {
    return this.failures.get(this.primaryOf(model));
  }

  /**
   * Load the model now. Waits for it to answer: Strata loads 35-55 GB into RAM,
   * which takes 1-3 minutes (longer the first time), and the HTTP server may not
   * answer at all until it is ready - so "unreachable" during a load we started
   * means "still loading", not "gone".
   *
   * `/load` already blocks until the model is in memory (measured: 95 s), so the
   * polling below only matters for a server that answers straight away.
   */
  async load(model: StrataModel, onProgress?: (elapsedS: number) => void): Promise<void> {
    const primary = this.primaryOf(model);
    if (this.isLoaded() && !this.loading.has(primary)) return;

    this.loading.add(primary);
    this.failures.delete(primary);
    const loadTimeout = await this.settings.resolveLoadTimeout();
    const deadline = Date.now() + loadTimeout;
    const started = Date.now();

    try {
      const ticker = setInterval(() => onProgress?.(Math.round((Date.now() - started) / 1000)), 1000);
      try {
        await this.client.load(Math.max(1000, deadline - Date.now()));
      } finally {
        clearInterval(ticker);
      }

      for (;;) {
        const health = await this.client.health(5000).catch(() => undefined);
        if (health?.loaded) {
          this.snapshot = { ...this.snapshot, health };
          return;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
        onProgress?.(Math.round((Date.now() - started) / 1000));
      }

      throw new Error(
        `${this.url} did not report the model as loaded within ${Math.round(loadTimeout / 1000)} s; ` +
          "it may still be loading - check its window or raise strataSettings.loadTimeout",
      );
    } catch (error) {
      this.failures.set(primary, (error as Error).message);
      throw error;
    } finally {
      this.loading.delete(primary);
    }
  }

  /** Give the VRAM and pinned RAM back. */
  async unload(): Promise<"unloaded" | "busy"> {
    const result = await this.client.unload();
    if (result === "unloaded") await this.refresh(await this.settings.resolveServerTimeout());
    return result;
  }

  /** Run the server's optional start command (a Strata process per installed model). */
  start(): void {
    if (!this.config.startCommand)
      throw new Error(`${this.url} has no startCommand - add one to strataSettings.servers`);
    const child = spawn(this.config.startCommand, { shell: true, detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  }

  /** Run the server's optional stop command. */
  stop(): void {
    if (!this.config.stopCommand)
      throw new Error(`${this.url} has no stopCommand - unload frees the GPU, or close its window`);
    const child = spawn(this.config.stopCommand, { shell: true, detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  }

  /** `GET /config`: Strata's Settings view of the run config. */
  configView(): Promise<StrataConfigView> {
    return this.client.configView();
  }

  /** `POST /config`: change run-config keys (used from the next start of the model). */
  setConfig(changes: Record<string, unknown>): Promise<StrataConfigView> {
    return this.client.setConfig(changes);
  }

  /** A one-line label for menus: `<icon> <id> (<ctx>[, alias])`. */
  label(model: StrataModel): string {
    const ctx = formatTokens(this.contextWindow(model));
    return `${ICONS[this.statusOf(model)]} ${model.id} (${ctx}${model.aliasOf ? ", alias" : ""})`;
  }

  /** Multi-line detail for the Info action. */
  info(model: StrataModel): string {
    const primary = this.primaryOf(model);
    const lines = [
      `Server        : ${this.url}`,
      `Model         : ${primary}${model.aliasOf ? ` (alias of ${model.aliasOf})` : ""}`,
      `Status        : ${this.statusOf(model)}`,
      `Context       : ${this.contextWindow(model).toLocaleString()} tokens`,
      `Max tokens    : ${this.maxTokens(model).toLocaleString()}`,
      `Capabilities  : ${this.capabilities(model).join(", ")}`,
      `Reasoning     : ${this.reasoning(model)}`,
      `Loads on use  : ${this.autoLoads()}`,
      `Engine        : ${this.snapshot.status?.engine ?? this.snapshot.props?.build_info ?? "unknown"}`,
    ];
    const vram = this.snapshot.status;
    if (vram) lines.push(`VRAM          : ${formatVram(vram)}`);
    if (this.snapshot.props?.model_path) lines.push(`Model file    : ${this.snapshot.props.model_path}`);
    const failure = this.failureOf(model);
    if (failure) lines.push(`Last error    : ${failure}`);
    return `${lines.join("\n")}\n`;
  }

  /** A readable summary for `/strata status`. */
  describe(): string {
    if (this.snapshot.error) return `${this.url}: ${this.snapshot.error.message}`;

    const status = this.snapshot.status;
    const health = this.snapshot.health;
    const model = this.snapshot.health?.model ?? "unknown";
    const lines = [
      `${this.providerName} - ${this.url}`,
      `  model      : ${model} (${this.isLoaded() ? "loaded" : this.autoLoads() ? "sleeping: loads on use" : "unloaded"})`,
      `  context    : ${(this.snapshot.status?.context?.native ?? health?.max_context ?? 0).toLocaleString()} tokens`,
      `  images     : ${this.capabilities({ id: model, name: model })[1] === "image" ? "yes" : "no"}`,
      `  engine     : ${status?.engine ?? "unknown"}${status?.uptime_s !== undefined ? `, up ${Math.floor(status.uptime_s / 60)} min` : ""}`,
    ];
    const concurrency = status?.concurrency?.serving ?? 1;
    const activity = status?.activity;
    lines.push(
      `  activity   : ${activity?.in_flight ?? 0} in flight, ${activity?.requests ?? 0} requests, ${concurrency} slot${concurrency === 1 ? "" : "s"}`,
    );
    if (status) lines.push(`  vram       : ${formatVram(status)}`);
    const timings = status?.last_timings;
    if (timings) lines.push(`  last turn  : ${formatTimings(timings)}`);
    if (health?.api_key) lines.push(`  api key    : required`);
    return lines.join("\n");
  }

  /** The Pi model configuration for one Strata model. */
  toProviderConfig(model: StrataModel): ChatModelConfig {
    const override = this.overrideFor(model) ?? {};
    const cost: ModelCost = {
      input: override.cost?.input ?? 0,
      output: override.cost?.output ?? 0,
      cacheRead: override.cost?.cacheRead ?? 0,
      cacheWrite: override.cost?.cacheWrite ?? 0,
    };

    return {
      id: model.id,
      name: model.name,
      reasoning: this.reasoning(model),
      // Strata knows none/low/medium/high; Pi's wider scale is clamped to it.
      thinkingLevelMap: { ...THINKING_LEVEL_MAP },
      input: this.capabilities(model),
      contextWindow: this.contextWindow(model),
      maxTokens: this.maxTokens(model),
      cost,
      compat: {
        // How Strata's OpenAI endpoint really behaves. Strata folds a
        // mid-conversation system message into a user message itself, so Pi
        // should keep folding them too; it takes `max_tokens`; and it replays
        // `reasoning_content` on assistant messages (its prefix cache depends
        // on the exact thinking text), so Pi sends it back.
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsMidConvoSystemMessages: false,
        requiresReasoningContentOnAssistantMessages: true,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "openai",
        ...override.compat,
      } as ChatModelConfig["compat"],
    };
  }
}

export const ICONS: Record<StrataStatusKind, string> = {
  loaded: "🟢",
  sleeping: "🔵",
  unloaded: "⚪",
  loading: "🟡",
  failed: "🔴",
  unauthorized: "⛔",
  unreachable: "🔴",
};

function formatTokens(value: number): string {
  return value >= 1024 ? `${Math.round(value / 1024)}K` : String(value);
}

/**
 * What the machine is doing: the GPU figures live under `machine.gpu`, the
 * elastic-engine figures under `vram` (which is often just `{elastic: false}`).
 */
function formatVram(status: StrataV1Status): string {
  const parts: string[] = [];

  const gpu = status.machine?.gpu;
  if (typeof gpu?.used_mib === "number" && typeof gpu.total_mib === "number")
    parts.push(
      `${Math.round(gpu.used_mib).toLocaleString()} / ${Math.round(gpu.total_mib).toLocaleString()} MiB used` +
        (gpu.name ? ` (${gpu.name})` : ""),
    );

  const vram = status.vram;
  if (typeof vram?.free_mib === "number") parts.push(`${Math.round(vram.free_mib).toLocaleString()} MiB free`);
  if (typeof vram?.expert_cache_mib === "number")
    parts.push(`expert cache ${Math.round(vram.expert_cache_mib).toLocaleString()} MiB`);
  if (vram?.elastic) parts.push("elastic");

  const ram = status.machine?.ram;
  if (typeof ram?.used_gib === "number" && typeof ram.total_gib === "number")
    parts.push(`RAM ${ram.used_gib} / ${ram.total_gib} GiB`);

  return parts.length > 0 ? parts.join(", ") : "unknown";
}

/** The last turn's timings, in the names Strata reports (llama.cpp's). */
function formatTimings(timings: Record<string, unknown>): string {
  const parts: string[] = [];
  const pick = (keys: string[], label: string, unit: string, exact = false) => {
    for (const key of keys) {
      const value = timings[key];
      if (typeof value === "number" && value > 0) {
        const shown = unit === "tok" && !exact ? value.toLocaleString() : String(Math.round(value * 10) / 10);
        parts.push(`${label} ${shown} ${unit}`);
        return;
      }
    }
  };
  pick(["predicted_per_second", "predicted_per_sec", "tokens_per_second"], "decode", "tok/s");
  pick(["prompt_per_second", "prompt_per_sec", "prefill_per_second"], "prefill", "tok/s");
  pick(["predicted_n", "predicted_tokens", "completion_tokens"], "generated", "tok");
  pick(["prompt_n", "prompt_tokens"], "prompt", "tok");
  pick(["cache_n"], "prefix cache", "tok");

  // Multi-token prediction: how much of the draft the model accepted.
  const draft = timings.draft_n;
  const accepted = timings.draft_n_accepted;
  if (typeof draft === "number" && draft > 0)
    parts.push(`draft ${typeof accepted === "number" ? `${accepted}/${draft}` : draft} accepted`);

  return parts.length > 0 ? parts.join(", ") : JSON.stringify(timings);
}
