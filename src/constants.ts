/**
 * Provider ID prefix. A server without an explicit `id` is addressed as
 * `strata-server=<url>`, which is also the address the catalog and the stored
 * credential travel under.
 */
export const PROVIDER_PREFIX = "strata-server";

/**
 * Provider ID of the entry that is always registered, even with nothing
 * configured: it is what `/login` fills in with a URL and an API key. With no
 * configuration at all it has no address and reports itself as unconfigured.
 */
export const PRIMARY_PROVIDER_ID = PROVIDER_PREFIX;

/** Settings key read from `.pi/settings.json` (project) and `~/.pi/agent/settings.json` (global). */
export const SETTINGS_KEY = "strataSettings";

/** Display name of the provider in Pi. */
export const PROVIDER_NAME = "Strata";

/** Wire protocol Strata's `/v1` endpoint speaks. */
export const API_TYPE = "openai-completions";

/** Used when nothing else configures the server. */
export const DEFAULT_URL = "http://127.0.0.1:8080";

/**
 * Strata answers every request when it runs without an `api_key`, so a
 * placeholder is enough for the common local case. With a key configured the
 * user stores the real one (`/login` or auth.json) and it replaces this.
 */
export const API_KEY_PLACEHOLDER = "strata";

/** Context window used when the server reports none. */
export const FALLBACK_CTX = 32768;

/**
 * Default cap on generated tokens. Strata shortens `max_tokens` itself when the
 * prompt would not fit (`fit_max_tokens`), so there is no need to offer the
 * whole context window for one answer - and thinking models can run away.
 */
export const DEFAULT_MAX_TOKENS = 32768;

/** Timeout (ms) for health probes and status reads. */
export const SERVER_TIMEOUT = 2000;

/**
 * Timeout (ms) for a load. Strata loads 35-55 GB into RAM: 1-3 minutes on a
 * warm start, longer the first time, so this is deliberately generous.
 */
export const LOAD_TIMEOUT = 900000;

/** Poll interval (ms) while waiting for a load to finish. */
export const POLL_INTERVAL = 1000;

/** Default for `reactToModelSelect`. */
export const REACT_TO_MODEL_SELECT = true;

/** Default for `autoloadOnMessage`. */
export const AUTOLOAD_ON_MESSAGE = false;

/** Default for `showServerUrls`. */
export const SHOW_SERVER_URLS = true;

/**
 * Pi thinking levels -> Strata's `reasoning_effort`.
 * Strata knows exactly four levels (none, low, medium, high), so Pi's wider
 * scale is clamped to it: `minimal` behaves like `low`, `xhigh`/`max` like `high`.
 */
export const THINKING_LEVEL_MAP = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;
