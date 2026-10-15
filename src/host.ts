import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiKeyCredential, Credential } from "@earendil-works/pi-ai";
import * as host from "@earendil-works/pi-coding-agent";

/**
 * The three hosts this extension runs under.
 *
 * Pi, oh-my-pi and dsh are the same lineage but not the same API. The
 * differences that matter here were measured against omp 18.8.9, Pi
 * 1.1.0/1.2.0 and pi2dsh 0.26.0 on dsh 0.2.0-rc.2:
 *
 * | | Pi | oh-my-pi | dsh (via pi2dsh) |
 * | --- | --- | --- | --- |
 * | `pi.registerProvider` | a native `Provider`, or `(name, config)` | `(name, config)` only | `(name, config)` only: a native one is taken, mounted as a route, and its transport is missing when a turn runs |
 * | interactive key setup | `auth.apiKey.login` runs on `/login` | none: the extension asks itself | none, and `auth.json` signs only this extension's calls, never a turn |
 * | where a turn's key comes from | `auth.json` / env | `auth.json` / env | `STRATA_API_KEY` (passed as `$STRATA_API_KEY`) or dsh's own Models page |
 * | settings | `settings.json` | not where it reads them | the file itself, under the agent dir the bridge redirects |
 * | `SettingsManager.reload()` | present | absent (`reloadFromDisk`) | the bridge's own, unread here |
 * | config dir | `.pi` | `.omp` | `$DSH_HOME/pi2dsh/agent` |
 *
 * Everything else is common: `pi.on`, `registerCommand`, `ctx.ui.*`,
 * `ctx.modelRegistry`, `getAgentDir`, `readStoredCredential`, and the
 * `model_select` / `before_provider_request` events.
 *
 * dsh is not a Pi fork: it is DeepSeek's own harness, and pi2dsh serves these
 * imports from a compatibility layer rather than from Pi. It says what it is -
 * its shim exports `VERSION = "pi2dsh-compat"` where Pi and oh-my-pi export a
 * version number - and it has to be known rather than inferred from a failed
 * registration, because it *accepts* a native `Provider` and only fails later,
 * when a turn runs (see {@link supportsNativeProviders}).
 * `StrataRegistry.ensureRegistered` stays as the backstop for a bridge that
 * says nothing.
 */
export type HostName = "pi" | "oh-my-pi" | "dsh";

/** `CONFIG_DIR_NAME` is exported by every host here and names the agent. */
export const CONFIG_DIR_NAME: string =
  (host as { CONFIG_DIR_NAME?: string }).CONFIG_DIR_NAME ?? ".pi";

/**
 * Whether a Pi-ABI bridge, rather than Pi itself, is answering these imports.
 *
 * pi2dsh's shim is explicit (`VERSION = "pi2dsh-compat"`); a bridge that
 * imitates Pi's version string instead is invisible here and falls back on the
 * registry's self-correction.
 */
export const isPiAbiBridge: boolean =
  (host as { VERSION?: string }).VERSION === "pi2dsh-compat";

export const hostName: HostName =
  CONFIG_DIR_NAME === ".omp" ? "oh-my-pi" : isPiAbiBridge ? "dsh" : "pi";

/**
 * Only Pi takes a single native `Provider` object.
 *
 * A bridge takes it too - and that is the trap. pi2dsh reads a `Provider` as
 * "this package owns the transport", so it mounts it as a DSH llm route whose
 * bytes our code is supposed to carry; but `pi-ai/compat` is the bridge's own
 * shim there, and its transport needs an active Agent runtime, which a route
 * invocation is not. Measured on dsh 0.2.0-rc.2: the model registers and is
 * selectable, and the first turn dies with `pi2dsh: pi-ai streamSimple() needs
 * a DSH llm service; this composition mounts none`. The `(name, config)` form is
 * the one that works: the bridge translates it into DSH's own `llm-pi-ai`
 * profile and DSH's adapter carries the request.
 */
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
 * normalised away: `strata-server=192.0.2.10-8081`. dsh goes one step
 * further and needs an id that can address one of its own credential records;
 * see {@link credentialSafeAddress}. The id is only ever compared with itself
 * inside one agent directory, so it never has to match across hosts.
 */
export function urlProviderId(prefix: string, url: string): string {
  if (hostName === "dsh") return `${prefix}-${credentialSafeAddress(url)}`;
  return `${prefix}=${hostName === "oh-my-pi" ? specSafeAddress(url) : url}`;
}

/**
 * An address written as one legal DSH credential-record segment.
 *
 * dsh's official `llm-pi-ai` adapter stores a route's key under a record id
 * that must match `/^[a-z][a-z0-9-]*$/` (`KEY_SEGMENT_PATTERN` in
 * `@deepseek-ai/dsh-credentials`); with any other id it answers
 * `provider id "..." cannot address a stored credential record`, which leaves
 * the environment as the only way to authenticate. So on dsh the address is
 * folded to lowercase letters, digits and hyphens: `strata-server-127-0-0-1-18099`
 * (the prefix always supplies the leading letter the pattern asks for).
 */
export function credentialSafeAddress(url: string): string {
  return (
    url
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unconfigured"
  );
}

/**
 * The `apiKey` to hand a `(name, config)` registration to this host.
 *
 * Pi and oh-my-pi use the key itself. dsh does not: the bridge turns a
 * catalog-only provider into DSH configuration and carries across only what
 * DSH can express as a credential reference - `envReferenceOf` in its
 * `provider-adapter.ts` accepts `$NAME` / `${NAME}` and drops anything else
 * (measured: with a literal key every turn failed `No API key for provider`,
 * with `$STRATA_API_KEY` the same turn answered). So when the environment
 * holds a key, it travels as a reference and DSH resolves it per request; when
 * it does not, the literal is passed anyway - harmless, and it leaves DSH free
 * to use a key stored in its own Models page.
 */
export function registrationApiKey(resolved: string, envName = "STRATA_API_KEY"): string {
  if (hostName !== "dsh") return resolved;
  return process.env[envName]?.trim() ? `$${envName}` : resolved;
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
