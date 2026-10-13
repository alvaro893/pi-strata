// Smoke test: drives the real extension modules (through jiti, like Pi does)
// against a stand-in Strata server. Run with: npm test
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { startFakeStrata } from "./fake-strata.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPath: join(process.cwd(), "tsconfig.json") });
const { StrataSettingsManager } = await jiti.import("../src/settings.ts");
const { StrataRegistry } = await jiti.import("../src/registry.ts");
const { ICONS } = await jiti.import("../src/server.ts");
const createExtension = (await jiti.import("../src/index.ts")).default;


/** A stand-in for Pi's ExtensionAPI. */
function fakePi() {
  const providers = new Map();
  const handlers = new Map();
  const commands = new Map();
  return {
    providers,
    handlers,
    commands,
    registerProvider(idOrProvider, config) {
      // Native provider objects arrive with one argument; the legacy
      // (id, config) pair with two.
      if (typeof idOrProvider === "string") providers.set(idOrProvider, config);
      else providers.set(idOrProvider.id, idOrProvider);
    },
    unregisterProvider(id) {
      providers.delete(id);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    async emit(event, payload, ctx) {
      return handlers.get(event)?.(payload, ctx);
    },
  };
}

/** A stand-in for Pi's ExtensionContext. */
function fakeCtx(overrides = {}) {
  const notices = [];
  const statuses = {};
  return {
    notices,
    statuses,
    hasUI: true,
    mode: "tui",
    model: undefined,
    thinkingLevel: undefined,
    ui: {
      notify: (message, type) => notices.push([type ?? "info", message]),
      setStatus: (key, text) => (statuses[key] = text),
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => true,
    },
    modelRegistry: { find: () => undefined },
    ...overrides,
  };
}

const temp = await mkdtemp(join(tmpdir(), "pi-strata-test-"));
process.chdir(temp);
// Isolate both settings layers: the project file in the temp cwd, the global
// file in a temp agent dir (never the real ~/.pi).
process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
await mkdir(join(temp, ".pi"), { recursive: true });
await mkdir(join(temp, "agent"), { recursive: true });
await writeFile(join(temp, ".pi", "settings.json"), "{}");
let open;
let lazy;
let keyed;

try {
  // ---------------------------------------------------------------- settings
  const settings = new StrataSettingsManager();
  await settings.setServers([
    { url: "http://127.0.0.1:9001", name: "one" },
    { url: "ftp://nope" },
    { url: "http://127.0.0.1:9002", overrides: { "m-": { contextSize: 4096, capabilities: ["text"] } } },
  ]);
  const written = JSON.parse(await readFile(join(temp, ".pi", "settings.json"), "utf-8"));  assert.equal(written.strataSettings.servers.length, 3, "all three entries are stored");

  const resolved = await settings.resolveServers();
  assert.deepEqual(
    resolved.map((server) => server.url),
    ["http://127.0.0.1:9001", "http://127.0.0.1:9002"],
    "the entry without a valid url is dropped",
  );
  assert.match(settings.takeWarnings().join("\n"), /ftp:\/\/nope/, "and reported as a warning");
  assert.equal(settings.findOverride(resolved[1].overrides, "m-foo").contextSize, 4096, "override prefix matches");
  assert.equal(settings.findOverride(resolved[1].overrides, "other"), undefined, "non-matching prefix ignored");

  await settings.setSetting("reactToModelSelect", false);
  assert.equal(await settings.resolveReactToModelSelect(), false, "scalar settings round-trip");

  // A hand-written provider for the same server is a source of the API key.
  process.env.STRATA_TEST_KEY = "from-models-json";
  await writeFile(
    join(temp, "agent", "models.json"),
    JSON.stringify({
      providers: {
        someones: { baseUrl: "http://127.0.0.1:9002/v1", apiKey: "$STRATA_TEST_KEY" },
        other: { baseUrl: "http://127.0.0.1:9555/v1", apiKey: "decoy" },
      },
    }),
  );
  assert.equal(
    settings.resolveApiKey("http://127.0.0.1:9002"),
    "from-models-json",
    "the key comes from a models.json provider at the same address (with /v1 ignored)",
  );
  assert.equal(settings.resolveApiKey("http://127.0.0.1:9999"), "strata", "and a placeholder otherwise");
  delete process.env.STRATA_TEST_KEY;

  // ------------------------------------------------------- client + registry
  open = await startFakeStrata({ loaded: false, autoLoad: false, loadDelayMs: 250 });
  lazy = await startFakeStrata({ loaded: false, autoLoad: true, model: "lazy-model", aliases: [] });
  keyed = await startFakeStrata({ apiKey: "secret", model: "keyed-model", aliases: [], loaded: true });
  process.env.STRATA_SERVER_URL = [open.url, lazy.url, keyed.url].join(";");
  delete process.env.STRATA_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;

  const pi = fakePi();
  const registry = new StrataRegistry(new StrataSettingsManager());
  const warnings = await registry.update(pi);

  const openServer = registry.getServer(open.url);
  const lazyServer = registry.getServer(lazy.url);
  const keyedServer = registry.getServer(keyed.url);
  const openProviderId = `strata-server=${open.url}`;

  assert.equal(openServer.models.length, 1, "an unloaded model is known only from /health");
  assert.equal(openServer.statusOf(openServer.models[0]), "unloaded", "unloaded model shows as unloaded");
  assert.equal(lazyServer.statusOf(lazyServer.models[0]), "sleeping", "lazy_load makes it sleeping");
  assert.equal(openServer.contextWindow(openServer.models[0]), 131072, "context comes from /health");
  assert.deepEqual(openServer.capabilities(openServer.models[0]), ["text", "image"], "vision detected");
  assert.equal(openServer.toPiModel(openServer.models[0]).maxTokens, 32768, "maxTokens is capped by default");
  assert.equal(openServer.toPiModel(openServer.models[0]).api, "openai-completions", "the catalog entry names its protocol");
  assert.equal(openServer.toPiModel(openServer.models[0]).provider, openProviderId, "and its provider");
  const summary = openServer.describe();
  assert.match(summary, /32,534 \/ 32,768 MiB used \(Test GPU\)/, "the GPU figures are shown");
  assert.match(summary, /decode 44\.4 tok\/s/, "and the last turn's decode rate");
  assert.match(summary, /draft 435\/679 accepted/, "and the draft acceptance");
  assert.equal(
    openServer.toPiModel(openServer.models[0]).compat.supportsMidConvoSystemMessages,
    false,
    "Strata's OpenAI quirks are configured",
  );

  assert.ok(pi.providers.has(openProviderId), "provider registered under strata-server=<url>");
  assert.equal(pi.providers.get(openProviderId).baseUrl, `${open.url}/v1`, "Pi talks to /v1");
  assert.equal(typeof pi.providers.get(openProviderId).auth?.apiKey?.login, "function", "/login asks for URL and key");

  // A server that wants a key still gets a provider, plus the /login hint.
  assert.ok(pi.providers.has(`strata-server=${keyed.url}`), "an unauthorized server still registers");
  assert.match(warnings.join("\n"), /refused the API key \(or has none\)/, "and warns about it");
  assert.equal(keyedServer.statusOf(keyedServer.models[0]), "unauthorized", "and the state says unauthorized");

  // ------------------------------------------------------------------ load
  const model = openServer.models[0];
  const loaded = await openServer.load(model);
  assert.equal(openServer.isLoaded(), true, "load() waits until /health says loaded");
  assert.equal(openServer.statusOf(model), "loaded", "status follows the load");
  assert.equal(loaded, undefined, "load resolves quietly");

  // Aliases appear once the model is in memory, and share its state.
  await openServer.refresh(2000);
  assert.deepEqual(
    openServer.models.map((entry) => entry.id),
    ["qwen3.8-flash-next-iq2_xs", "iq2_xs"],
    "the model and its alias are both offered",
  );
  const alias = openServer.models[1];
  assert.equal(openServer.statusOf(alias), "loaded", "an alias reports its model's state");
  assert.equal(openServer.contextWindow(alias), 131072, "an alias inherits the context");
  assert.equal(openServer.toPiModel(alias).name, "iq2_xs", "the alias keeps its own name");

  // ---------------------------------------------------------------- unload
  assert.equal(await openServer.unload(model), "unloaded", "unload frees the model");
  assert.equal(openServer.isLoaded(), false, "and the status follows");

  open.setBusy(true);
  assert.equal(await openServer.unload(model), "busy", "a running request keeps the model loaded");
  open.setBusy(false);

  // ------------------------------------------------------------- run config
  const view = await openServer.configView();
  assert.ok(view.keys.some((key) => key.key === "temperature"), "the run config is readable");
  await openServer.setConfig({ temperature: 0.1 });
  assert.equal(open.state.config.temperature, 0.1, "and writable through the server's own endpoint");

  // The catalog Pi sees comes from the provider's refreshModels(). Loading the
  // model first is what makes the alias appear (Strata lists a model's aliases
  // only once it is in memory).
  await openServer.load(openServer.models[0]);
  const provider = pi.providers.get(openProviderId);
  const published = [];
  const refreshContext = {
    credential: undefined,
    stored: undefined,
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => {
      published.push(publication);
      publication.update?.();
      return true;
    },
  };
  await provider.refreshModels(refreshContext);
  assert.equal(provider.getModels().length, 2, "the catalog holds the model and its alias");
  assert.equal(published.at(-1).persist.models.length, 2, "and it is persisted for the next session");
  assert.equal(published.at(-1).persist.models[0].provider, openProviderId, "under this provider");

  // An unconfigured provider restores its stored catalog without touching the network.
  const offline = [];
  await provider.refreshModels({
    ...refreshContext,
    credential: undefined,
    allowNetwork: false,
    publish: async (publication) => { offline.push(publication); publication.update?.(); return true; },
  });
  assert.equal(offline.length, 0, "offline refresh neither reads nor writes");

  // /login: a URL and a key, asked interactively, proven against the server.
  const keyedProvider = pi.providers.get(`strata-server=${keyed.url}`);
  const answers = [keyed.url, "secret"];
  const prompts = [];
  const credential = await keyedProvider.auth.apiKey.login({
    signal: new AbortController().signal,
    prompt: async (prompt) => { prompts.push(prompt); return answers.shift() ?? ""; },
    notify: () => undefined,
  });
  assert.equal(prompts[0].type, "text", "the URL is asked as text");
  assert.equal(prompts[1].type, "secret", "the key is asked as a secret");
  assert.equal(credential.type, "api_key", "a login stores an api-key credential");
  assert.equal(credential.key, "secret", "with the key");
  assert.equal(credential.env.STRATA_SERVER_URL, keyed.url, "and the URL, so one credential holds both");

  // A wrong key is rejected before anything is stored.
  await assert.rejects(
    () => keyedProvider.auth.apiKey.login({
      signal: new AbortController().signal,
      prompt: async (prompt) => (prompt.type === "text" ? keyed.url : "wrong"),
      notify: () => undefined,
    }),
    /rejected that API key/,
    "a bad key fails the login instead of being stored",
  );

  // An unreachable address is rejected too, naming it and the reason.
  await assert.rejects(
    () => keyedProvider.auth.apiKey.login({
      signal: new AbortController().signal,
      prompt: async (prompt) => (prompt.type === "text" ? "127.0.0.1:45999" : ""),
      notify: () => undefined,
    }),
    /cannot reach http:\/\/127\.0\.0\.1:45999/,
    "an unreachable address is refused, scheme or no scheme",
  );

  // The address as it is read off a machine running Strata - no scheme - is the
  // shape people type, and what used to fail with "Failed to parse URL".
  const schemeLess = await keyedProvider.auth.apiKey.login({
    signal: new AbortController().signal,
    prompt: async (prompt) => (prompt.type === "text" ? keyed.url.replace(/^https?:\/\//, "") : "secret"),
    notify: () => undefined,
  });
  assert.equal(schemeLess.env.STRATA_SERVER_URL, keyed.url, "a bare host:port is accepted and completed");
  assert.equal(schemeLess.key, "secret", "and the key is stored with it");

  // resolve() reports the connection it would use, and nothing when unset.
  const loggedIn = await keyedProvider.auth.apiKey.resolve({
    ctx: { env: async () => undefined, fileExists: async () => false },
    credential,
    signal: new AbortController().signal,
  });
  assert.equal(loggedIn.auth.baseUrl, `${keyed.url}/v1`, "requests go to /v1 of the stored URL");
  assert.equal(loggedIn.auth.apiKey, "secret", "with the stored key");

  // The control endpoints only answer for "own page or no browser": a JSON
  // Content-Type is required, and a foreign Origin is refused.
  const refused = await fetch(`${open.url}/load`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(refused.status, 403, "a non-JSON control request is refused");
  const foreign = await fetch(`${open.url}/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
    body: "{}",
  });
  assert.equal(foreign.status, 403, "a foreign origin is refused");

  // ------------------------------------------------------------- key + down
  process.env.STRATA_API_KEY = "secret";
  await registry.update(pi);
  assert.equal(registry.getServer(keyed.url).models[0].id, "keyed-model", "the key unlocks the server");
  assert.ok(pi.providers.has(`strata-server=${keyed.url}`), "the provider is registered once a key is set");
  assert.equal(registry.getServer(keyed.url).models.length, 1, "and its model is known");

  const closed = await startFakeStrata({ aliases: [] });
  const closedUrl = closed.url;
  await closed.close();
  process.env.STRATA_SERVER_URL = closedUrl;
  delete process.env.STRATA_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
  const downRegistry = new StrataRegistry(new StrataSettingsManager());
  const downPi = fakePi();
  const downWarnings = await downRegistry.update(downPi);
  const downServer = downRegistry.getServer(closedUrl);
  assert.equal(downServer.statusOf({ id: "x", name: "x" }), "unreachable", "a closed port is unreachable");
  // The provider stays registered (so /login can point it somewhere else) but
  // publishes no models, and the warning says why.
  const downProvider = downPi.providers.get(`strata-server=${closedUrl}`);
  assert.ok(downProvider, "an unreachable server keeps its provider");
  assert.equal(downProvider.getModels().length, 0, "with no models");
  await downProvider.refreshModels({
    credential: undefined,
    stored: undefined,
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => { publication.update?.(); return true; },
  });
  assert.equal(downProvider.getModels().length, 0, "a failed refresh keeps it empty");
  assert.match(downWarnings.join("\n"), /cannot reach/, "and says so");

  // --------------------------------------------------------------- wiring
  process.env.STRATA_SERVER_URL = open.url;
  await writeFile(
    join(temp, ".pi", "settings.json"),
    JSON.stringify({ strataSettings: { servers: [{ url: open.url }], reasoningBudgets: { medium: 4096 } } }, null, 2),
  );
  const wired = fakePi();
  await createExtension(wired);
  const ctx = fakeCtx();

  await wired.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.ok(wired.providers.has(openProviderId), "the extension registers the provider on load");

  // /strata status works without a UI.
  const quiet = fakeCtx({ hasUI: false });
  await wired.commands.get("strata").handler("status", quiet);
  assert.match(quiet.notices[0]?.[1] ?? "", /model      :/, "/strata status prints the server summary");

  // The footer line reflects the live state.
  const statusCtx = fakeCtx({ model: { id: openServer.models[0].id, provider: openProviderId } });
  await openServer.refresh(2000);
  await wired.emit("session_start", { type: "session_start", reason: "startup" }, statusCtx);
  assert.match(statusCtx.statuses.Strata ?? "", new RegExp(ICONS[openServer.statusOf(openServer.models[0])]), "status line icon");

  // before_provider_request: only Strata models get a thinking budget.
  const request = await wired.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { model: openServer.models[0].id, reasoning_effort: "medium" } },
    fakeCtx({ thinkingLevel: "medium" }),
  );
  assert.equal(request.reasoning_budget_tokens, 4096, "the configured budget is injected");

  const other = await wired.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { model: "gpt-5", reasoning_effort: "medium" } },
    fakeCtx({ thinkingLevel: "medium" }),
  );
  assert.equal(other, undefined, "another provider's request is left alone");

  const off = await wired.emit(
    "before_provider_request",
    { type: "before_provider_request", payload: { model: openServer.models[0].id, reasoning_effort: "none" } },
    fakeCtx({ thinkingLevel: "off" }),
  );
  assert.equal(off, undefined, "thinking off sends no budget");

  // model_select loads an unloaded model (through the extension's own server
  // object, so the proof is the fake server's state, not a cached snapshot).
  await openServer.unload(openServer.models[0]);
  const selectCtx = fakeCtx();
  await wired.emit(
    "model_select",
    {
      type: "model_select",
      model: { id: openServer.models[0].id, provider: openProviderId },
      previousModel: undefined,
      source: "user",
    },
    selectCtx,
  );
  assert.equal(open.state.loaded, true, "model_select loads the model");
  assert.match(selectCtx.notices.map(([, text]) => text).join("\n"), /Loading/, "and says so");
} finally {
  delete process.env.STRATA_SERVER_URL;
  delete process.env.STRATA_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.STRATA_TEST_KEY;
  await Promise.all([open, lazy, keyed].map(async (server) => server && (await server.close())));
  process.chdir(tmpdir());
  await rm(temp, { recursive: true, force: true });
}

console.log("ok - smoke test passed");
