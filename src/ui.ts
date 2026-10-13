import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ICONS, type StrataModel, type StrataServer } from "./server.ts";
import type { StrataRegistry } from "./registry.ts";
import type { StrataSettingsManager } from "./settings.ts";
import type { StrataConfigKey, StrataSettings, StrataServerConfig } from "./types.ts";

const REFRESH = "🔄 Refresh";
const STATUS = "📊 Status";
const SERVERS = "🖥  Servers…";
const SETTINGS = "⚙  Settings…";
const RUN_CONFIG = "🎛  Run config…";
const CANCEL = "Cancel";

/** `<icon> <id> (<ctx>[, <server>])` for the model list. */
export function formatModelLabel(
  server: StrataServer,
  model: StrataModel,
  showServerUrls: boolean,
): string {
  const ctx = server.contextWindow(model);
  const parts = [
    `${Math.round(ctx / 1024)}K`,
    server.capabilities(model).includes("image") ? "vision" : "text",
    showServerUrls ? (server.config.name ?? server.url) : "",
  ].filter(Boolean);
  return `${ICONS[server.statusOf(model)]} ${model.id}${model.aliasOf ? ` → ${model.aliasOf}` : ""} (${parts.join(", ")})`;
}

/**
 * The model browser: pick a model, then an action.
 * Mirrors the llama.cpp extension's flow (switch / load / unload / info / retry).
 */
export async function browseModels(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  registry: StrataRegistry,
  settings: StrataSettingsManager,
): Promise<void> {
  const showServerUrls = await settings.resolveShowServerUrls();

  for (;;) {
    const located = registry.getAllModels();
    const labels = located.map(({ server, model }) => formatModelLabel(server, model, showServerUrls));
    const choice = await ctx.ui.select(
      "Strata models (green = loaded, blue = wakes on use, grey = unloaded)",
      [...labels, REFRESH, STATUS, SERVERS, SETTINGS, RUN_CONFIG, CANCEL],
    );
    if (!choice || choice === CANCEL) return;

    if (choice === REFRESH) {
      await refresh(pi, ctx, registry);
      continue;
    }
    if (choice === STATUS) {
      showStatus(ctx, registry);
      continue;
    }
    if (choice === SERVERS) {
      await manageServers(pi, ctx, registry, settings);
      continue;
    }
    if (choice === SETTINGS) {
      await editSettings(ctx, settings);
      continue;
    }
    if (choice === RUN_CONFIG) {
      await editRunConfig(pi, ctx, registry);
      continue;
    }

    const index = labels.indexOf(choice);
    const picked = located[index];
    if (!picked) return;
    await modelActions(pi, ctx, settings, picked.server, picked.model);
  }
}

async function modelActions(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: StrataSettingsManager,
  server: StrataServer,
  model: StrataModel,
): Promise<void> {
  const kind = server.statusOf(model);
  const canLoad = kind !== "loaded" && kind !== "sleeping";
  const canUnload = kind === "loaded" || kind === "sleeping";
  const canStart = kind === "unreachable" && !!server.config.startCommand;

  const SWITCH = "Switch to this model";
  const LOAD = canLoad ? "Load model" : undefined;
  const UNLOAD = canUnload ? "Unload model" : undefined;
  const START = canStart ? "Start server" : undefined;
  const RETRY = kind === "failed" ? "Retry" : undefined;
  const INFO = "Info";
  const DEFAULT = "Set as default model";

  const choice = await ctx.ui.select(server.label(model), [
    SWITCH,
    LOAD,
    UNLOAD,
    START,
    RETRY,
    INFO,
    DEFAULT,
    CANCEL,
  ].filter(Boolean) as string[]);

  switch (choice) {
    case SWITCH:
    case RETRY:
      await switchToModel(pi, ctx, settings, server, model);
      break;
    case LOAD:
      await loadModel(ctx, server, model);
      break;
    case UNLOAD:
      await unloadModel(ctx, server, model);
      break;
    case START:
      try {
        server.start();
        ctx.ui.notify(`Started ${server.url}; it registers itself when it answers`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
      break;
    case DEFAULT:
      settings.setDefaultModel(server.providerId, model.id);
      ctx.ui.notify(`Default model: ${server.providerId}/${model.id}`, "info");
      break;
    case INFO:
      ctx.ui.notify(server.info(model), "info");
      break;
  }
}

/**
 * Point Pi at the model, then load it if the server does not have it yet.
 *
 * `pi.setModel` fires `model_select`, which loads the model on its own when
 * `reactToModelSelect` is on; the explicit load here covers the case where the
 * model was already selected (Pi's setModel returns false) or the setting is off.
 */
async function switchToModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  settings: StrataSettingsManager,
  server: StrataServer,
  model: StrataModel,
): Promise<void> {
  const piModel = ctx.modelRegistry.find(server.providerId, model.id);
  if (!piModel) {
    ctx.ui.notify(`Pi does not know ${model.id} yet - ${REFRESH.toLowerCase()} first`, "warning");
    return;
  }

  const reactToModelSelect = await settings.resolveReactToModelSelect();
  const switched = await pi.setModel(piModel);
  if (!switched) {
    ctx.ui.notify(`Already on ${model.id}`, "info");
    return;
  }
  if (reactToModelSelect) return; // model_select handles the load
  const kind = server.statusOf(model);
  if (kind === "loaded" || kind === "sleeping") return;
  await loadModel(ctx, server, model);
}

/** Load a model, keeping the footer status line informative. */
export async function loadModel(
  ctx: ExtensionContext,
  server: StrataServer,
  model: StrataModel,
): Promise<boolean> {
  const key = "Strata";
  ctx.ui.setStatus(key, `🟡 loading ${model.id} on ${server.url} (1-3 min)...`);
  ctx.ui.notify(`Loading ${model.id} into ${server.url} - Strata reads 35-55 GB, so this takes a while`, "info");
  try {
    await server.load(model, (elapsed) =>
      ctx.ui.setStatus(key, `🟡 loading ${model.id} (${elapsed}s)...`),
    );
    ctx.ui.notify(`Loaded ${model.id} on ${server.url}`, "info");
    return true;
  } catch (error) {
    ctx.ui.notify(`Could not load ${model.id}: ${(error as Error).message}`, "error");
    return false;
  } finally {
    ctx.ui.setStatus(key, undefined);
  }
}

export async function unloadModel(
  ctx: ExtensionContext,
  server: StrataServer,
  model: StrataModel,
): Promise<void> {
  try {
    const result = await server.unload();
    ctx.ui.notify(
      result === "busy"
        ? `${server.url} is still answering a request, so ${model.id} stayed loaded`
        : `Unloaded ${model.id}: ${server.url} gave the VRAM back`,
      result === "busy" ? "warning" : "info",
    );
  } catch (error) {
    ctx.ui.notify(`Could not unload ${model.id}: ${(error as Error).message}`, "error");
  }
}

/** `/strata status`: one block per server. */
export function showStatus(ctx: ExtensionContext, registry: StrataRegistry): void {
  const servers = registry.getServers();
  if (servers.length === 0) {
    ctx.ui.notify("No Strata server configured - /strata servers to add one", "warning");
    return;
  }
  ctx.ui.notify(`\n${servers.map((server) => server.describe()).join("\n\n")}\n`, "info");
}

/** `/strata servers`: list, add, edit, remove. */
export async function manageServers(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  registry: StrataRegistry,
  settings: StrataSettingsManager,
): Promise<void> {
  for (;;) {
    const configured = await settings.resolveServers();
    const labels = configured.map((server) => {
      const live = registry.getServer(server.url);
      const icon = live ? ICONS[live.statusOf(live.models[0] ?? { id: "", name: "" })] : "⚪";
      return `${icon} ${server.name ?? server.url} - ${server.url}`;
    });

    const choice = await ctx.ui.select("Strata servers", [
      ...labels,
      "➕ Add server",
      ...(labels.length > 0 ? ["✏️ Edit server", "🗑 Remove server"] : []),
      CANCEL,
    ]);
    if (!choice || choice === CANCEL) return;

    if (choice === "➕ Add server") {
      const url = await promptUrl(ctx, "http://127.0.0.1:8080");
      if (!url) continue;
      const name = (await ctx.ui.input("Display name (optional)", "workstation"))?.trim();
      const startCommand = (await ctx.ui.input("Start command (optional)", "nohup ./run-model.sh &"))?.trim();
      const servers = configured.some((server) => server.url === url)
        ? configured
        : [...configured, { url }];
      await settings.setServers(
        servers.map((server) =>
          server.url === url
            ? { ...server, ...(name ? { name } : {}), ...(startCommand ? { startCommand } : {}) }
            : server,
        ),
      );
      await refresh(pi, ctx, registry);
      continue;
    }

    if (choice === "✏️ Edit server") {
      const server = await pickServer(ctx, configured);
      if (!server) continue;
      const url = await promptUrl(ctx, server.url);
      if (!url) continue;
      const name = (await ctx.ui.input("Display name (optional)", server.name ?? ""))?.trim();
      const startCommand = (await ctx.ui.input("Start command (optional)", server.startCommand ?? ""))?.trim();
      await settings.setServers(
        configured.map((entry) =>
          entry.url === server.url
            ? {
                ...entry,
                url,
                ...(name ? { name } : { name: undefined }),
                ...(startCommand ? { startCommand } : { startCommand: undefined }),
              }
            : entry,
        ),
      );
      await refresh(pi, ctx, registry);
      continue;
    }

    if (choice === "🗑 Remove server") {
      const server = await pickServer(ctx, configured);
      if (!server) continue;
      const confirmed = await ctx.ui.confirm("Remove server", `Forget ${server.url}? (its settings stay on disk)`);
      if (!confirmed) continue;
      await settings.setServers(configured.filter((entry) => entry.url !== server.url));
      registry.forget(pi, server.url);
      continue;
    }

    // A server entry was picked: show what is known about it.
    const picked = configured[labels.indexOf(choice)];
    if (!picked) return;
    const live = registry.getServer(picked.url);
    ctx.ui.notify(live ? live.describe() : `${picked.url}: not probed yet`, "info");
  }
}

async function pickServer(
  ctx: ExtensionCommandContext,
  configured: StrataServerConfig[],
): Promise<StrataServerConfig | undefined> {
  const labels = configured.map((server) => server.name ?? server.url);
  const choice = await ctx.ui.select("Which server?", labels);
  if (!choice) return undefined;
  return configured[labels.indexOf(choice)];
}

async function promptUrl(ctx: ExtensionCommandContext, placeholder: string): Promise<string | undefined> {
  const url = (await ctx.ui.input("Strata server URL", placeholder))?.trim().replace(/\/+$/, "");
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) {
    ctx.ui.notify("The URL needs http:// or https://", "error");
    return undefined;
  }
  // Accept a pasted `<url>/v1` and use its root.
  return url.endsWith("/v1") ? url.slice(0, -"/v1".length) : url;
}

/** `/strata settings`: toggle the extension's own behaviour. */
export async function editSettings(
  ctx: ExtensionCommandContext,
  settings: StrataSettingsManager,
): Promise<void> {
  const current = await settings.get();

  const TOGGLE_REACT = `${current.reactToModelSelect ? "✅" : "⬜"} Load when the model is picked`;
  const TOGGLE_AUTOLOAD = `${current.autoloadOnMessage ? "✅" : "⬜"} Load before the first message`;
  const TOGGLE_URLS = `${current.showServerUrls ? "✅" : "⬜"} Show the server in the model list`;
  const TOGGLE_STATUS = `${current.statusLine ?? true ? "✅" : "⬜"} Show a status line in the footer`;
  const TIMEOUTS = `⏱  Timeouts: ${current.serverTimeout ?? 2000} ms probe / ${current.loadTimeout ?? 900000} ms load`;

  const choice = await ctx.ui.select("Strata settings", [
    TOGGLE_REACT,
    TOGGLE_AUTOLOAD,
    TOGGLE_URLS,
    TOGGLE_STATUS,
    TIMEOUTS,
    CANCEL,
  ]);

  switch (choice) {
    case TOGGLE_REACT:
      await settings.setSetting("reactToModelSelect", !(current.reactToModelSelect ?? true));
      break;
    case TOGGLE_AUTOLOAD:
      await settings.setSetting("autoloadOnMessage", !(current.autoloadOnMessage ?? false));
      break;
    case TOGGLE_URLS:
      await settings.setSetting("showServerUrls", !(current.showServerUrls ?? true));
      break;
    case TOGGLE_STATUS:
      await settings.setSetting("statusLine", !(current.statusLine ?? true));
      break;
    case TIMEOUTS: {
      const probe = await ctx.ui.input("Probe timeout (ms)", String(current.serverTimeout ?? 2000));
      if (probe && Number(probe) > 0) await settings.setSetting("serverTimeout", Number(probe));
      const load = await ctx.ui.input("Load timeout (ms)", String(current.loadTimeout ?? 900000));
      if (load && Number(load) > 0) await settings.setSetting("loadTimeout", Number(load));
      break;
    }
  }
}

/**
 * `/strata config`: read and change Strata's run config through the server's
 * own Settings endpoint (`GET`/`POST /config`), so the change lands in the same
 * file Strata's page edits. Values apply from the next start of the model.
 */
export async function editRunConfig(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  registry: StrataRegistry,
): Promise<void> {
  const servers = registry.getServers();
  if (servers.length === 0) {
    ctx.ui.notify("No Strata server to configure", "warning");
    return;
  }

  const labels = servers.map((server) => server.config.name ?? server.url);
  const pickedLabel = await ctx.ui.select("Configure which server?", labels);
  if (!pickedLabel) return;
  const server = servers[labels.indexOf(pickedLabel)];
  if (!server) return;

  let view;
  try {
    view = await server.configView();
  } catch (error) {
    ctx.ui.notify(`Cannot read ${server.url}/config: ${(error as Error).message}`, "error");
    return;
  }

  const keys = view.keys ?? [];
  if (keys.length === 0) {
    ctx.ui.notify(view.note ?? `${server.url} has no editable run config`, "warning");
    return;
  }

  const keyLabels = keys.map((key) => `${key.key} = ${formatValue(key.value)}`);
  const chosen = await ctx.ui.select(`Run config (${view.file ?? "in memory"})`, [...keyLabels, CANCEL]);
  if (!chosen || chosen === CANCEL) return;
  const key = keys[keyLabels.indexOf(chosen)];
  if (!key) return;

  const input = await ctx.ui.input(
    `${key.key}\n${key.help ?? ""}`.slice(0, 400),
    key.choices?.join(" | ") ?? String(key.value ?? ""),
  );
  if (input === undefined) return;

  const value = parseValue(input, key);
  if (value === undefined) {
    ctx.ui.notify(`Not a valid value for ${key.key}: ${input}`, "error");
    return;
  }

  try {
    await server.setConfig({ [key.key]: value });
    ctx.ui.notify(`Set ${key.key} = ${formatValue(value)} (used from the next load of the model)`, "info");
  } catch (error) {
    ctx.ui.notify(`Cannot change ${key.key}: ${(error as Error).message}`, "error");
  }
  await refresh(pi, ctx, registry);
}

/** Use the key's declared kind/choices; otherwise keep numbers and booleans as they look. */
function parseValue(input: string, key: StrataConfigKey): unknown {
  const text = input.trim();
  if (key.choices?.length) return key.choices.includes(text) ? text : undefined;
  if (key.kind === "int" || key.kind === "number") return Number.isFinite(Number(text)) ? Number(text) : undefined;
  if (key.kind === "bool") {
    if (["true", "yes", "on", "1"].includes(text.toLowerCase())) return true;
    if (["false", "no", "off", "0"].includes(text.toLowerCase())) return false;
    return undefined;
  }
  if (typeof key.value === "boolean") {
    if (["true", "yes", "on", "1"].includes(text.toLowerCase())) return true;
    if (["false", "no", "off", "0"].includes(text.toLowerCase())) return false;
    return undefined;
  }
  if (typeof key.value === "number") return Number.isFinite(Number(text)) ? Number(text) : undefined;
  return text;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(unset)";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Re-scan every server and re-register the providers, reporting problems. */
export async function refresh(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registry: StrataRegistry,
): Promise<void> {
  const warnings = await registry.update(pi);
  for (const warning of warnings) ctx.ui.notify(warning, "warning");
  if (warnings.length === 0) ctx.ui.notify("Strata servers refreshed", "info");
}

/** Settings type used by the UI helpers (kept for the caller's convenience). */
export type { StrataSettings };
