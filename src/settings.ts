import { execSync } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApiKeyCredential } from "@earendil-works/pi-ai";
import { normalizeRoot, parseServerUrl } from "./client.ts";
import {
  modelsJsonProviders,
  readCredential,
  settingsPaths,
  supportsDefaultModelSetting,
  urlProviderId,
} from "./host.ts";
import {
  API_KEY_PLACEHOLDER,
  AUTOLOAD_ON_MESSAGE,
  LOAD_TIMEOUT,
  PRIMARY_PROVIDER_ID,
  PROVIDER_PREFIX,
  REACT_TO_MODEL_SELECT,
  SERVER_TIMEOUT,
  SETTINGS_KEY,
  SHOW_SERVER_URLS,
} from "./constants.ts";
import type { StrataModelOverride, StrataServerConfig, StrataSettings } from "./types.ts";

/** Whole-file read/write of one settings.json, with atomic writes. */
class SettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw error;
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`cannot parse ${this.path}: ${String(error)}`);
    }
  }

  /** Read-modify-write of one top-level key; writes are queued (last write wins). */
  updateKey(key: string, update: (current: unknown) => unknown): Promise<void> {
    const run = async () => {
      const root = await this.read();
      root[key] = update(root[key]);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(root, null, 2), "utf-8");
      await rename(tmp, this.path);
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }
}

/**
 * Resolve an auth.json key: literal, `$VAR` / `${VAR}`, or `!command`.
 * `$$` and `$!` escape a literal `$` / `!`.
 */
function resolveKey(key: string, env?: Record<string, string>): string {
  if (!key) return API_KEY_PLACEHOLDER;
  if (key.startsWith("!")) {
    try {
      return (
        execSync(key.slice(1), { encoding: "utf-8", timeout: 10_000 }).trim() || API_KEY_PLACEHOLDER
      );
    } catch {
      return API_KEY_PLACEHOLDER;
    }
  }
  if (key.startsWith("$$") || key.startsWith("$!")) return key.charAt(1) + key.slice(2);
  if (!key.startsWith("$")) return key;

  const name =
    key.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] ??
    key.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  if (!name) return API_KEY_PLACEHOLDER;
  return env?.[name] ?? process.env[name] ?? API_KEY_PLACEHOLDER;
}

/**
 * Reads the extension's settings (project over global) and resolves the
 * servers, API keys and behaviour flags from them.
 *
 * Resolution order for the server list:
 * 1. `STRATA_SERVER_URL` (semicolon-separated for several servers)
 * 2. `strataSettings.servers` in `.pi/settings.json` / `~/.pi/agent/settings.json`
 * 3. `http://127.0.0.1:8080`
 */
export class StrataSettingsManager {
  // Paths come from the host, so this works under Pi (.pi) and oh-my-pi (.omp).
  private readonly paths = settingsPaths(process.cwd());
  private readonly globalStore = new SettingsStore(this.paths.global);
  private readonly projectStore = new SettingsStore(this.paths.project);

  /** Warnings about dropped configuration entries, drained once per scan. */
  private warnings: string[] = [];

  takeWarnings(): string[] {
    const taken = this.warnings;
    this.warnings = [];
    return taken;
  }

  /**
   * The effective settings: this extension reads the files itself.
   *
   * Under Pi that is the very file Pi reads; under oh-my-pi the host's settings
   * live elsewhere (its `SettingsManager` reports only `setupVersion`, and its
   * `writeValue` is broken in 18.8.9), so a file this extension owns is the
   * only thing that behaves the same on both.
   */
  private async merged(): Promise<Record<string, unknown>> {
    const [global, project] = await Promise.all([this.globalStore.read(), this.projectStore.read()]);
    return { ...global, ...project };
  }

  async get(): Promise<StrataSettings> {
    return ((await this.merged())[SETTINGS_KEY] ?? {}) as StrataSettings;
  }

  private async hasProjectSettings(): Promise<boolean> {
    try {
      await access(this.paths.project);
      return true;
    } catch {
      return false;
    }
  }

  /** The provider ID of a server: its `id`, else `strata-server=<url>`. */
  static providerId(url: string, customId?: string): string {
    if (customId) return customId;
    return url ? urlProviderId(PROVIDER_PREFIX, url) : PRIMARY_PROVIDER_ID;
  }

  /**
   * The servers to connect to, with per-server overrides applied.
   * Invalid entries are dropped with a warning; duplicates are removed.
   */
  async resolveServers(): Promise<StrataServerConfig[]> {
    const configured = (await this.get()).servers ?? [];
    const urls = await this.resolveUrls();

    const servers: StrataServerConfig[] = [];
    const seen = new Set<string>();
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      const config = configured.find((server) => server.url === url);
      servers.push({ ...config, url, overrides: config?.overrides ?? {} });
    }
    return servers;
  }

  private async resolveUrls(): Promise<string[]> {
    const fromEnv = (process.env.STRATA_SERVER_URL ?? "")
      .split(";")
      .map((url) => {
        try {
          return parseServerUrl(url);
        } catch (error) {
          this.warnings.push(`[pi-strata] STRATA_SERVER_URL: ${(error as Error).message}`);
          return "";
        }
      })
      .filter(Boolean);
    if (fromEnv.length > 0) return fromEnv;

    const configured = (await this.get()).servers ?? [];
    const urls: string[] = [];
    for (const server of configured) {
      const entered = typeof server?.url === "string" ? server.url : "";
      if (!entered.trim()) {
        this.warnings.push("[pi-strata] a strataSettings.servers entry has no url; skipped");
        continue;
      }
      try {
        // A bare `host:port` is accepted; only real nonsense is refused.
        urls.push(parseServerUrl(entered));
      } catch (error) {
        this.warnings.push(`[pi-strata] ${(error as Error).message}`);
      }
    }
    // No implicit default: an unconfigured extension registers one provider
    // with no address instead, so /login can ask for it.
    return urls;
  }

  /**
   * The API key for a provider, in order:
   * 1. auth.json under the custom id, then under `strata-server=<url>`
   * 2. `STRATA_API_KEY`
   * 3. the `apiKey` of a `models.json` provider pointed at the same server
   * 4. a placeholder (Strata accepts any key when it runs without one)
   */
  resolveApiKey(url: string, customId?: string): string {
    const ids = customId
      ? [customId, StrataSettingsManager.providerId(url)]
      : [StrataSettingsManager.providerId(url)];
    for (const id of ids) {
      const credential = readCredential(id) as ApiKeyCredential | undefined;
      if (credential?.key) return resolveKey(credential.key, credential.env);
    }
    return process.env.STRATA_API_KEY || modelsJsonKey(url) || API_KEY_PLACEHOLDER;
  }

  /** The override that applies to a model id: the longest matching key wins. */
  findOverride(
    overrides: Record<string, StrataModelOverride> | undefined,
    modelId: string,
  ): StrataModelOverride | undefined {
    let best: StrataModelOverride | undefined;
    let bestLength = 0;
    for (const [key, value] of Object.entries(overrides ?? {})) {
      if (key && modelId.startsWith(key) && key.length > bestLength) {
        best = value;
        bestLength = key.length;
      }
    }
    return best;
  }

  async resolveReactToModelSelect(): Promise<boolean> {
    return (await this.get()).reactToModelSelect ?? REACT_TO_MODEL_SELECT;
  }

  async resolveAutoloadOnMessage(): Promise<boolean> {
    return (await this.get()).autoloadOnMessage ?? AUTOLOAD_ON_MESSAGE;
  }

  async resolveShowServerUrls(): Promise<boolean> {
    return (await this.get()).showServerUrls ?? SHOW_SERVER_URLS;
  }

  async resolveServerTimeout(): Promise<number> {
    return (await this.get()).serverTimeout ?? SERVER_TIMEOUT;
  }

  async resolveLoadTimeout(): Promise<number> {
    return (await this.get()).loadTimeout ?? LOAD_TIMEOUT;
  }

  async resolveReasoningBudgets(): Promise<Partial<Record<string, number>>> {
    return (await this.get()).reasoningBudgets ?? {};
  }

  /**
   * Persist one `strataSettings` field. With `auto` the project file is used
   * when it exists, otherwise the global one.
   */
  async setSetting<K extends keyof StrataSettings>(
    key: K,
    value: StrataSettings[K],
    scope: "auto" | "global" | "project" = "auto",
  ): Promise<void> {
    const store =
      scope === "auto"
        ? (await this.hasProjectSettings())
          ? this.projectStore
          : this.globalStore
        : scope === "project"
          ? this.projectStore
          : this.globalStore;

    await store.updateKey(SETTINGS_KEY, (current) => ({
      ...(typeof current === "object" && current !== null ? (current as object) : {}),
      [key]: value,
    }));
  }

  /** Persist the whole `strataSettings.servers` list. */
  async setServers(servers: StrataServerConfig[]): Promise<void> {
    await this.setSetting("servers", servers);
  }

  /** Persist the overrides of one server. */
  async setOverrides(url: string, overrides: Record<string, StrataModelOverride>): Promise<void> {
    const servers = await this.resolveServers();
    await this.setServers(servers.map((server) => (server.url === url ? { ...server, overrides } : server)));
  }

  /**
   * Make a Strata model the default one.
   *
   * Pi keeps `defaultProvider`/`defaultModel` in the settings file this
   * extension writes anyway. oh-my-pi keeps its model roles elsewhere and
   * exposes no way in, so it is not offered there.
   */
  async setDefaultModel(provider: string, modelId: string): Promise<boolean> {
    if (!supportsDefaultModelSetting) return false;
    const store = (await this.hasProjectSettings()) ? this.projectStore : this.globalStore;
    await store.updateKey("defaultProvider", () => provider);
    await store.updateKey("defaultModel", () => modelId);
    return true;
  }

  /** The configured default thinking level, if any. */
  async getThinkingLevel(): Promise<string | undefined> {
    const settings = await this.merged();
    const level = settings.defaultThinkingLevel;
    return typeof level === "string" ? level : undefined;
  }
}

export function createSettingsManager(): StrataSettingsManager {
  return new StrataSettingsManager();
}

/**
 * Look for a `models.json` provider that points at the same server and reuse
 * its key, so a hand-written provider for the same address keeps working.
 */
function modelsJsonKey(url: string): string | undefined {
  let file: {
    providers?: Record<string, { baseUrl?: string; apiKey?: string; env?: Record<string, string> }>;
  };
  try {
    file = { providers: modelsJsonProviders() } as typeof file;
  } catch {
    return undefined;
  }

  const target = normalizeRoot(url);
  for (const provider of Object.values(file.providers ?? {})) {
    if (!provider?.baseUrl || typeof provider.apiKey !== "string" || !provider.apiKey) continue;
    // `http://host:8081` and `http://host:8081/v1` are the same server.
    if (normalizeRoot(provider.baseUrl) !== target) continue;
    return resolveKey(provider.apiKey, provider.env);
  }
  return undefined;
}
