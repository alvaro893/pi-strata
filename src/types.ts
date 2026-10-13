import type { Model } from "@earendil-works/pi-ai";

/** A Strata model as Pi's catalog sees it (OpenAI-completions wire protocol). */
export type StrataPiModel = Model<"openai-completions">;

/** Shape of one entry in `strataSettings.servers`. */
export interface StrataServerConfig {
  /** Root of the Strata server, e.g. `http://127.0.0.1:8080` (no `/v1`). */
  url: string;
  /** Provider ID override; also the auth.json key. Defaults to `strata-server=<url>`. */
  id?: string;
  /** Display name suffix: shown as `Strata (<name>)`. */
  name?: string;
  /**
   * Optional shell command that starts this server (e.g.
   * `nohup ./run-iq2_xs.sh --port 8081 >/tmp/strata.log 2>&1 &`).
   * Offered as a "Start server" action when the server is unreachable.
   */
  startCommand?: string;
  /** Optional shell command that stops it (Strata's own window/`strata_stop` also work). */
  stopCommand?: string;
  /** Per-model overrides, keyed by model id prefix (longest match wins). */
  overrides?: Record<string, StrataModelOverride>;
}

/**
 * Per-model overrides. Every field is optional; absent fields fall back to
 * what the server reports or to this extension's defaults.
 */
export interface StrataModelOverride {
  /** Cost per million tokens; unspecified fields are zero. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** Replaces the detected input modalities. */
  capabilities?: ("text" | "image")[];
  /** Whether the model thinks. Default: true (Strata's models are hybrid). */
  reasoning?: boolean;
  /** Context window in tokens; falls back to the server's value when absent or 0. */
  contextSize?: number;
  /** Max generation tokens; falls back to the context window when absent or 0. */
  maxTokens?: number;
  /** OpenAI-compatibility flags passed through to Pi. */
  compat?: Record<string, unknown>;
}

/** Scalar settings under `strataSettings`. */
export interface StrataSettings {
  servers?: StrataServerConfig[];
  /** Load the model when it is picked in Pi's model picker. Default: true. */
  reactToModelSelect?: boolean;
  /** Load an unloaded model before the first message instead of letting the request wait. Default: false. */
  autoloadOnMessage?: boolean;
  /** Show `[Server: <url>]` in the model list. Default: true. */
  showServerUrls?: boolean;
  /** Keep a footer status line with the live server state. Default: true. */
  statusLine?: boolean;
  /** Timeout (ms) for health/status requests. Default: 2000. */
  serverTimeout?: number;
  /** Timeout (ms) for a model load. Default: 900000. */
  loadTimeout?: number;
  /**
   * Per-thinking-level cap on thinking tokens, sent as `reasoning_budget_tokens`.
   * Off by default: Strata's `reasoning_effort` levels already set the thinking length.
   */
  reasoningBudgets?: Partial<Record<"minimal" | "low" | "medium" | "high" | "xhigh", number>>;
}

/** `GET /health` - the only endpoint that needs no API key. */
export interface StrataHealth {
  status: string;
  service?: string;
  model: string;
  max_context?: number;
  images?: boolean;
  api_key?: boolean;
  loaded?: boolean;
}

/** `GET /v1/models`. */
export interface StrataModelsResponse {
  object: string;
  data: {
    id: string;
    object?: string;
    status?: { value?: string };
    meta?: { n_ctx?: number };
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
    aliases?: string[];
    alias_of?: string;
  }[];
}

/** `GET /v1/status` - the fields this extension reads; the server sends more. */
export interface StrataV1Status {
  service?: string;
  model?: string;
  loaded?: boolean;
  auto_load?: boolean;
  engine?: string;
  uptime_s?: number;
  cache_max_tokens?: number;
  context?: { native?: number; max_positions?: number };
  concurrency?: { serving?: number; requested?: number };
  vision?: { enabled?: boolean; available?: boolean };
  activity?: { requests?: number; in_flight?: number; last_request_at?: number };
  last_timings?: Record<string, number | string | null> | null;
  vram?: { elastic?: boolean; free_mib?: number; expert_cache_mib?: number; expert_slots?: number };
  machine?: {
    at?: number;
    gpu?: { name?: string; used_mib?: number; total_mib?: number; util_pct?: number; temp_c?: number };
    ram?: { used_gib?: number; total_gib?: number };
  };
}

/** `GET /props`. */
export interface StrataProps {
  default_generation_settings?: { n_ctx?: number };
  total_slots?: number;
  model_alias?: string;
  modalities?: { vision?: boolean };
  models_autoload?: boolean;
  is_sleeping?: boolean;
  model_path?: string;
  build_info?: string;
}

/** `GET /status` - the live request line (busy, tok/s, prompt tokens, ...). */
export type StrataBusyStatus = Record<string, unknown>;

/** One key of `GET /config` (Strata's Settings view). */
export interface StrataConfigKey {
  key: string;
  value: unknown;
  help?: string;
  kind?: string;
  choices?: string[];
}

/** `GET`/`POST /config`. */
export interface StrataConfigView {
  file?: string;
  keys?: StrataConfigKey[];
  note?: string;
  changed?: string[];
}

/** How a server/model looked at the last probe. */
export type StrataStatusKind =
  | "loaded"
  | "sleeping"
  | "unloaded"
  | "loading"
  | "failed"
  | "unauthorized"
  | "unreachable";
