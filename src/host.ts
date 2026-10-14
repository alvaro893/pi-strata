import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiKeyCredential, Credential } from "@earendil-works/pi-ai";
import * as host from "@earendil-works/pi-coding-agent";

/**
 * The two hosts this extension runs under.
 *
 * Pi and oh-my-pi are the same lineage but not the same API. The differences
 * that matter here were measured against omp 18.8.9 and Pi 1.1.0/1.2.0:
 *
 * | | Pi | oh-my-pi |
 * | --- | --- | --- |
 * | `pi.registerProvider` | a native `Provider`, or `(name, config)` | `(name, config)` only |
 * | interactive key setup | `auth.apiKey.login` runs on `/login` | none: the extension asks itself |
 * | settings | `settings.json` | not where it reads them |
 * | `SettingsManager.reload()` | present | absent (`reloadFromDisk`) |
 * | config dir | `.pi` | `.omp` |
 *
 * Everything else is common: `pi.on`, `registerCommand`, `ctx.ui.*`,
 * `ctx.modelRegistry`, `getAgentDir`, `readStoredCredential`, and the
 * `model_select` / `before_provider_request` events.
 *
 * A third kind of host has no entry here: a Pi-ABI bridge such as pi2dsh on
 * DeepSeek Harness, which serves these imports from its own compatibility
 * surface. It is not detectable from an export, so it is treated as Pi and
 * corrected by observation instead - the registry checks what the host really
 * registered and falls back to `(name, config)`; see
 * `StrataRegistry.ensureRegistered`.
 */
export type HostName = "pi" | "oh-my-pi";

/** `CONFIG_DIR_NAME` is exported by both hosts and names the agent. */
export const CONFIG_DIR_NAME: string =
  (host as { CONFIG_DIR_NAME?: string }).CONFIG_DIR_NAME ?? ".pi";

export const hostName: HostName = CONFIG_DIR_NAME === ".omp" ? "oh-my-pi" : "pi";

/** Only Pi's extension API accepts a single native `Provider` object. */
export const supportsNativeProviders = hostName === "pi";

/** Only Pi runs `auth.apiKey.login` from its own `/login` dialog. */
export const supportsLoginDialog = hostName === "pi";

/** Only Pi keeps its default model somewhere this extension can write. */
export const supportsDefaultModelSetting = hostName === "pi";

/**
 * The provider id for a server address.
 *
 * A URL-based id keeps the address visible, which Pi reads happily. oh-my-pi
 * resolves `--model provider/model` itself and stops at a colon in the provider
 * id (measured: `strata=eqtest` and `strata.dot-test` resolve,
 * `strata:colontest` does not), so there the scheme and the port separator are
 * normalised away: `strata-server=192.168.0.62-8081`. The id is only ever
 * compared with itself inside one agent directory, so it never has to match
 * across hosts.
 */
export function urlProviderId(prefix: string, url: string): string {
  return `${prefix}=${hostName === "oh-my-pi" ? specSafeAddress(url) : url}`;
}

/**
 * An address that survives oh-my-pi's `--model provider/model` parsing: the
 * scheme and the colons go. Exported so the rule can be tested on its own.
 */
export function specSafeAddress(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/:/g, "-");
}

/** The host's agent directory (`~/.pi/agent` or `~/.omp/agent`). */
export function agentDir(): string {
  try {
    return host.getAgentDir();
  } catch {
    const name = hostName === "oh-my-pi" ? "omp" : "pi";
    return join(process.env.HOME ?? ".", `.${name}`, "agent");
  }
}

/** Where this extension keeps its settings: the host's own `settings.json`. */
export function settingsPaths(cwd: string): { global: string; project: string } {
  return {
    global: join(agentDir(), "settings.json"),
    project: join(cwd, CONFIG_DIR_NAME, "settings.json"),
  };
}

/** Pi and oh-my-pi both keep `provider -> credential` in this file. */
export function authPath(): string {
  return join(agentDir(), "auth.json");
}

/** Hand-written providers, and a key for a server already configured there. */
export function modelsPath(): string {
  return join(agentDir(), "models.json");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * A stored credential.
 *
 * Read from `auth.json` directly rather than through the host, because that is
 * the file both hosts write and the only one whose behaviour this extension can
 * rely on: oh-my-pi moved its credentials into SQLite and keeps the file for
 * compatibility, while `readStoredCredential` may or may not see it. The host's
 * own reader is still consulted as a fallback.
 */
export function readCredential(providerId: string): Credential | undefined {
  const stored = readJson<Record<string, Credential>>(authPath())?.[providerId];
  if (stored && typeof stored === "object" && "type" in stored) return stored;
  try {
    return host.readStoredCredential(providerId) as Credential | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write an api-key credential, preserving every other entry in the file.
 *
 * @returns true when the file was written
 */
export function writeCredential(providerId: string, credential: ApiKeyCredential): boolean {
  const path = authPath();
  const file = readJson<Record<string, unknown>>(path) ?? {};
  file[providerId] = credential;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Remove a credential; `false` when nothing was stored under that id. */
export function deleteCredential(providerId: string): boolean {
  const path = authPath();
  const file = readJson<Record<string, unknown>>(path);
  if (!file || !(providerId in file)) return false;
  delete file[providerId];
  try {
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** The `providers` map of `models.json` (`{}` when the file is absent). */
export function modelsJsonProviders(): Record<
  string,
  { baseUrl?: string; apiKey?: string; env?: Record<string, string> }
> {
  return readJson<{ providers?: Record<string, never> }>(modelsPath())?.providers ?? {};
}
