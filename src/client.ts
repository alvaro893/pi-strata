import type {
  StrataBusyStatus,
  StrataConfigView,
  StrataHealth,
  StrataModelsResponse,
  StrataProps,
  StrataV1Status,
} from "./types.ts";

/** What went wrong on a request to a Strata server. */
export type StrataErrorKind = "unauthorized" | "unreachable" | "timeout" | "http";

export class StrataError extends Error {
  constructor(
    message: string,
    readonly kind: StrataErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StrataError";
  }
}

/**
 * Strip a trailing slash and an accidental `/v1` suffix.
 *
 * @returns The server root (native endpoints like `/health` live directly under it)
 */
export function normalizeRoot(url: string): string {
  let root = url.trim().replace(/\/+$/, "");
  if (root.endsWith("/v1")) root = root.slice(0, -"/v1".length);
  return root;
}

/**
 * Minimal HTTP client for one Strata server.
 *
 * Endpoints used (see Strata's `serve/server.py`):
 * - `GET  /health`     - no auth; model, context, images, loaded
 * - `GET  /v1/models`  - the model and its aliases (empty while unloaded)
 * - `GET  /v1/status`  - loaded/auto_load, VRAM, vision, timings, engine
 * - `GET  /props`      - is_sleeping, models_autoload, build_info
 * - `GET  /status`     - the live request line (busy, tokens/s)
 * - `GET|POST /config` - Strata's Settings view of the run config
 * - `POST /load|/unload` - take the model, or give the GPU back
 *
 * The control endpoints answer only for "Strata's own page or a client that is
 * no browser": they require `Content-Type: application/json` and reject a
 * foreign `Origin`. Node's fetch sends neither by default, which is exactly
 * what these calls need - do not add an `Origin` header here.
 */
export class StrataClient {
  constructor(
    readonly root: string,
    readonly apiKey: string,
  ) {}

  /** Base URL of the OpenAI-compatible API registered with Pi. */
  get apiBaseUrl(): string {
    return `${this.root}/v1`;
  }

  private headers(withJsonBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (withJsonBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; timeout?: number } = {},
  ): Promise<T> {
    const { method = "GET", body, timeout = 5000 } = options;
    let response: Response;

    try {
      response = await fetch(this.root + path, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new StrataError(
        isTimeout
          ? `no answer from ${this.root}${path} within ${timeout} ms`
          : `cannot reach ${this.root}: ${(error as Error).message}`,
        isTimeout ? "timeout" : "unreachable",
      );
    }

    // Strata reports failures as {"error": {"type", "message"}}.
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    if (!response.ok) {
      const message = extractError(payload) ?? `${response.status} ${response.statusText}`;
      if (response.status === 401 || response.status === 403)
        throw new StrataError(message, "unauthorized", response.status);
      throw new StrataError(message, "http", response.status);
    }

    return payload as T;
  }

  /** `GET /health` - reachable, and which model this server serves. */
  health(timeout?: number): Promise<StrataHealth> {
    return this.request<StrataHealth>("/health", { timeout });
  }

  /** `GET /v1/models` - the model plus its aliases; empty while unloaded and not auto-loadable. */
  models(timeout?: number): Promise<StrataModelsResponse> {
    return this.request<StrataModelsResponse>("/v1/models", { timeout });
  }

  /** `GET /v1/status` - the richest single read of a Strata server. */
  status(timeout?: number): Promise<StrataV1Status> {
    return this.request<StrataV1Status>("/v1/status", { timeout });
  }

  /** `GET /props` - sleeping state, autoload capability, engine build. */
  props(timeout?: number): Promise<StrataProps> {
    return this.request<StrataProps>("/props", { timeout });
  }

  /** `GET /status` - what the server is doing right now. */
  busyStatus(timeout?: number): Promise<StrataBusyStatus> {
    return this.request<StrataBusyStatus>("/status", { timeout });
  }

  /** `GET /config` - the documented run-config keys (Settings view). */
  configView(timeout?: number): Promise<StrataConfigView> {
    return this.request<StrataConfigView>("/config", { timeout });
  }

  /** `POST /config` - change run-config keys; they apply from the next start of the model. */
  setConfig(changes: Record<string, unknown>): Promise<StrataConfigView> {
    return this.request<StrataConfigView>("/config", { method: "POST", body: { set: changes } });
  }

  /**
   * `POST /load` - load the model now instead of waiting for the first request.
   *
   * Strata does not answer until the model is in memory: 35-55 GB are read from
   * disk, which takes 1-3 minutes (measured: 95 s on a warm page cache), so the
   * timeout has to cover a whole load. 503 with `Retry-After` means the GPU is
   * busy with another request.
   *
   * @param timeout - ms to wait for the answer (default: 15 min)
   */
  load(timeout = 900_000): Promise<{ status?: string }> {
    // An empty JSON body: the server consumes it before answering (Windows
    // would otherwise reset the connection) and only its Content-Type matters.
    return this.request<{ status?: string }>("/load", { method: "POST", body: {}, timeout });
  }

  /**
   * `POST /unload` - give the VRAM and pinned RAM back. The engine has to exit,
   * so this takes seconds, not milliseconds.
   *
   * @param wait - seconds to wait for a running request to finish (Strata's `?wait=`)
   * @param timeout - ms to wait for the answer (default: 5 min)
   */
  async unload(wait?: number, timeout = 300_000): Promise<"unloaded" | "busy"> {
    const path = wait ? `/unload?wait=${Math.round(wait)}` : "/unload";
    try {
      const result = await this.request<{ status?: string }>(path, { method: "POST", body: {}, timeout });
      return result?.status === "busy" ? "busy" : "unloaded";
    } catch (error) {
      // 409: a request is running or queued, so nothing was unloaded.
      if (error instanceof StrataError && error.status === 409) return "busy";
      throw error;
    }
  }

  /** `POST /v1/vram` - ask the elastic engine to leave `reserveMiB` of VRAM free. */
  vram(reserveMiB: number | null): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/v1/vram", {
      method: "POST",
      body: { reserve_mib: reserveMiB },
    });
  }
}

function extractError(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return undefined;
}
