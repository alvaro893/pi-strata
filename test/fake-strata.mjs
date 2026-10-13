// A stand-in for Strata's HTTP server (serve/server.py), used by test/smoke.mjs.
// It mirrors the endpoints pi-strata uses, including the two behaviours that
// are easy to get wrong: the "own page or a client that is no browser" check on
// the control endpoints, and the empty model list while a model is unloaded.
import http from "node:http";

const DEFAULT_KEYS = [
  { key: "reasoning_budget_tokens", value: 8192, kind: "int", help: "Default cap on thinking tokens." },
  { key: "idle_unload_s", value: 0, kind: "int", help: "Unload this many seconds after the last request." },
  { key: "lazy_load", value: false, kind: "bool", help: "Start without the model and load it on the first request." },
  { key: "fit_max_tokens", value: 4096, kind: "int", help: "Shorten max_tokens when the prompt would not fit." },
  { key: "temperature", value: 0.7, kind: "number", help: "Default sampling temperature." },
  { key: "engine", value: "cuda", kind: "str", help: "Engine to run.", choices: ["cuda", "vulkan", "cpu"] },
];

export function startFakeStrata(options = {}) {
  const {
    port = 0,
    apiKey = undefined,
    model = "qwen3.8-flash-next-iq2_xs",
    maxContext = 131072,
    images = true,
    aliases = ["iq2_xs"],
    loaded = false,
    autoLoad = false,
    loadDelayMs = 300,
    keys = DEFAULT_KEYS.map((key) => ({ ...key })),
  } = options;

  const state = {
    model,
    loaded,
    autoLoad,
    requests: 0,
    inFlight: 0,
    config: Object.fromEntries(keys.map((key) => [key.key, key.value])),
    startedAt: Date.now(),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    state.requests++;

    const send = (status, body) => {
      const payload = JSON.stringify(body);
      // The real server closes the connection on control replies; keep-alive is fine here.
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload);
    };

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const authorized = !apiKey || req.headers.authorization === `Bearer ${apiKey}`;
      // Strata's control endpoints answer for its own page or a client that is
      // no browser: JSON content type required, foreign Origin refused.
      const ownPage = () => {
        const type = req.headers["content-type"] ?? "";
        if (!type.includes("application/json")) {
          send(403, { error: { message: `only Strata's own page may change ${path}` } });
          return false;
        }
        const origin = (req.headers.origin ?? "").replace(/\/$/, "");
        if (origin && origin.replace(/^\w+:\/\//, "") !== req.headers.host) {
          send(403, { error: { message: `a page of another origin cannot use ${path}` } });
          return false;
        }
        return true;
      };

      if (path === "/health")
        return send(200, {
          status: "ok",
          service: "strata",
          model: state.model,
          max_context: maxContext,
          images,
          api_key: !!apiKey,
          loaded: state.loaded,
        });

      if (!authorized) return send(401, { error: { type: "authentication_error", message: "missing or wrong API key" } });

      if (path === "/v1/models") {
        // While unloaded and not auto-loadable, Strata lists nothing at all.
        if (!state.loaded && !state.autoLoad) return send(200, { object: "list", data: [] });
        const modalities = images ? ["text", "image"] : ["text"];
        const entry = (id, aliasOf) => ({
          id,
          object: "model",
          status: { value: state.loaded ? "loaded" : "unloaded" },
          meta: { n_ctx: maxContext },
          architecture: { input_modalities: modalities, output_modalities: ["text"] },
          ...(aliasOf ? { alias_of: aliasOf } : { aliases }),
        });
        return send(200, {
          object: "list",
          data: [entry(state.model), ...aliases.map((alias) => entry(alias, state.model))],
        });
      }

      if (path === "/v1/status")
        return send(200, {
          service: "strata",
          model: state.model,
          loaded: state.loaded,
          auto_load: state.autoLoad,
          engine: "strata-cuda (build fake)",
          uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
          context: { native: maxContext },
          concurrency: { serving: 1, requested: 1 },
          vision: { enabled: images, available: images },
          activity: { requests: state.requests, in_flight: state.inFlight, last_request_at: 1 },
          last_timings: {
            cache_n: 98802,
            prompt_n: 32,
            prompt_per_second: 88.4,
            predicted_n: 701,
            predicted_per_second: 44.4,
            draft_n: 679,
            draft_n_accepted: 435,
          },
          // The real server sends machine.gpu; vram is often just the elastic flag.
          vram: { elastic: false },
          machine: {
            at: Math.round(Date.now() / 1000),
            gpu: { name: "Test GPU", used_mib: 32534, total_mib: 32768, util_pct: 0, temp_c: 55 },
            ram: { used_gib: 63.5, total_gib: 74.3 },
          },
        });

      if (path === "/props")
        return send(200, {
          default_generation_settings: { n_ctx: maxContext },
          total_slots: 4,
          model_alias: aliases[0] ?? state.model,
          modalities: { vision: images },
          models_autoload: state.autoLoad,
          is_sleeping: !state.loaded && state.autoLoad,
          model_path: "/models/qwen3.8-flash-next-iq2_xs.gguf",
          build_info: "fake",
        });

      if (path === "/status")
        return send(200, { busy: state.inFlight > 0, tokens_per_s: 42.3, prompt_tokens: 128, queued: 0 });

      if (path === "/config" && req.method === "GET")
        return send(200, {
          file: "/run/strata/config.json",
          keys: keys.map((key) => ({ ...key, value: state.config[key.key] })),
          note: "changes apply from the next start",
        });

      if (path === "/config" && req.method === "POST") {
        if (!ownPage()) return;
        const changed = [];
        for (const [key, value] of Object.entries(JSON.parse(body || "{}").set ?? {})) {
          if (!keys.some((entry) => entry.key === key))
            return send(400, { error: { type: "invalid_request_error", message: `${key} is not editable` } });
          state.config[key] = value;
          changed.push(key);
        }
        return send(200, { file: "/run/strata/config.json", keys: keys.map((key) => ({ ...key, value: state.config[key.key] })), changed });
      }

      if (path === "/load" || path === "/v1/load") {
        if (!ownPage()) return;
        if (state.inFlight > 0)
          return send(503, { error: { message: "the GPU is busy; try again when the request has finished" } });
        // The real server does not answer until the model is in memory.
        setTimeout(() => {
          state.loaded = true;
          send(200, { status: "loaded" });
        }, loadDelayMs);
        return undefined;
      }

      if (path === "/unload" || path === "/v1/unload") {
        if (!ownPage()) return;
        if (state.inFlight > 0) return send(200, { status: "busy" });
        state.loaded = false;
        return send(200, { status: "unloaded" });
      }

      if (path === "/v1/chat/completions") {
        state.inFlight++;
        state.inFlight--;
        return send(200, { id: 1, object: "chat.completion", model: state.model, choices: [{ message: { role: "assistant", content: "ok" } }] });
      }

      return send(404, { error: { message: `no endpoint ${path}` } });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        setBusy(value) {
          state.inFlight = value ? 1 : 0;
        },
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}
