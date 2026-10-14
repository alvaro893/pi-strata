import type { ApiKeyCredential } from "@earendil-works/pi-ai";
import { readCredential } from "./host.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { supportsNativeProviders } from "./host.ts";
import { API_TYPE } from "./constants.ts";
import { createStrataProvider, credentialUrl, toLegacyModelConfig } from "./provider.ts";
import { StrataSettingsManager } from "./settings.ts";
import { type StrataModel, StrataServer } from "./server.ts";
import type { StrataServerConfig } from "./types.ts";

/** A model plus the server that serves it. */
export interface LocatedModel {
  server: StrataServer;
  model: StrataModel;
}

/**
 * How a provider is handed to the host.
 *
 * `native` is Pi's single-`Provider` registration, which is what lets `/login`
 * ask for a URL and a key. `legacy` is `(name, config)`, the only form
 * oh-my-pi accepts and the one any other bridge is most likely to implement,
 * because the model list and the key are plain data.
 *
 * Which one works is decided statically from the host when it is known, and
 * corrected at runtime by looking at what actually ended up in the model
 * registry - see {@link StrataRegistry.ensureRegistered}. That is what keeps a
 * host we cannot test (a Pi-ABI bridge such as pi2dsh on DeepSeek Harness)
 * from failing silently.
 */
export type RegistrationMode = "native" | "legacy";

/**
 * The Strata servers Pi is connected to.
 *
 * Every server is registered as its own provider. With nothing configured the
 * extension still registers one empty provider, so `/login` has an entry to
 * fill in: no environment variable is required.
 */
export class StrataRegistry {
  private servers = new Map<string, StrataServer>();

  /** Provider IDs this extension registered, to forget removed servers. */
  private readonly registered = new Set<string>();

  /** Corrected by observation; starts from what the host says it is. */
  private mode: RegistrationMode = supportsNativeProviders ? "native" : "legacy";

  /** Set once a host refuses a second provider (DeepSeek Harness allows one). */
  private singleProviderHost = false;

  /** Servers this host cannot take, because it mounts one provider per session. */
  private readonly skipped = new Set<string>();

  /** Only warn about a missing registration once. */
  private warnedMissing = false;

  constructor(private readonly settings: StrataSettingsManager) {}

  /** Whether the last registration attempt was accepted by the host. */
  get registrationMode(): RegistrationMode {
    return this.mode;
  }

  getServers(): StrataServer[] {
    return [...this.servers.values()];
  }

  getServer(url: string): StrataServer | undefined {
    return this.servers.get(url);
  }

  /** The server serving a model id (aliases included), or undefined. */
  getServerForModel(modelId: string): LocatedModel | undefined {
    if (!modelId) return undefined;
    for (const server of this.servers.values()) {
      const model = server.models.find((candidate) => candidate.id === modelId);
      if (model) return { server, model };
    }
    return undefined;
  }

  getAllModels(): LocatedModel[] {
    return [...this.servers.values()].flatMap((server) =>
      server.models.map((model) => ({ server, model })),
    );
  }

  /**
   * Re-read the configuration, probe every server and (re)register the providers.
   *
   * @returns Warnings worth showing to the user
   */
  async update(pi: ExtensionAPI): Promise<string[]> {
    const warnings = [...this.settings.takeWarnings()];
    const timeout = await this.settings.resolveServerTimeout();
    const configured = await this.settings.resolveServers();
    // With nothing configured anywhere, register one provider with no address:
    // that is the entry `/login` asks a URL and a key for.
    const configs = configured.length > 0 ? configured : [{ url: "" }];

    // Reuse the existing object per address: a load in flight keeps its state,
    // and a credential that moved a server keeps its new address.
    const next = new Map<string, StrataServer>();
    for (const config of configs) {
      const key = config.url || "";
      if (next.has(key)) continue; // one provider per address
      const existing = key ? this.servers.get(key) : undefined;
      const server =
        existing && sameConfig(existing.config, config)
          ? existing
          : new StrataServer(
              config,
              this.settings.resolveApiKey(config.url, config.id),
              this.settings,
            );
      next.set(key, server);
    }
    this.servers = next;

    await Promise.all(
      [...this.servers.values()].map(async (server) => {
        // What `/login` stored is a source of truth the configuration may not
        // know about: it holds both the address and the key. Reading it here is
        // what lets a logged-in server be up to date in a non-interactive run.
        const credential = readCredential(server.providerId) as ApiKeyCredential | undefined;
        const url = credentialUrl(credential) ?? server.config.url;
        if (url) server.useUrl(url);
        server.useApiKey(
          credential?.key ?? (url ? this.settings.resolveApiKey(url, server.config.id) : ""),
        );

        // Probe before registering: the provider is seeded with what the probe
        // found, so the models exist before Pi's first catalog snapshot.
        if (url) await server.refresh(timeout);
      }),
    );
    this.registerAll(pi, warnings);

    // Forget providers whose server disappeared from the configuration.
    for (const id of [...this.registered]) {
      if (![...this.servers.values()].some((server) => server.providerId === id)) {
        pi.unregisterProvider(id);
        this.registered.delete(id);
      }
    }

    for (const server of this.servers.values()) {
      const error = server.probeError;
      // An unauthorized server is reported by register() with the /login hint.
      if (error && error.kind !== "unauthorized") warnings.push(error.message);
    }
    return warnings;
  }

  /**
   * Register every server with the host, in the current mode.
   *
   * A host that refuses a second provider (DeepSeek Harness mounts one per
   * context) is detected here: the first server keeps its provider and the rest
   * are reported instead of pretending they work.
   */
  registerAll(pi: ExtensionAPI, warnings: string[] = []): void {
    for (const server of this.servers.values()) {
      if (this.singleProviderHost && this.registered.size > 0) {
        if (this.registered.has(server.providerId)) continue;
        this.skipped.add(server.providerId);
        warnings.push(this.singleProviderWarning(server));
        continue;
      }
      this.register(pi, server, warnings);
    }
  }

  /**
   * Register one server with the host.
   *
   * Pi gets a native `Provider`, which is what lets `/login` ask for the URL
   * and the key. oh-my-pi and other Pi-ABI bridges get `(name, config)`, where
   * the model list and the key are fixed at registration time and refreshed by
   * registering again (see `update`, called after anything that changes them).
   */
  register(pi: ExtensionAPI, server: StrataServer, warnings: string[] = []): void {
    if (server.probeError?.kind === "unauthorized" && server.config.url)
      warnings.push(
        `${server.url} refused the API key (or has none): ` +
          `run /strata connect to enter the URL and the key it expects`,
      );

    try {
      if (this.mode === "native") {
        pi.registerProvider(createStrataProvider(server, (url) => this.settings.resolveApiKey(url)));
      } else {
        const url = server.url;
        pi.registerProvider(server.providerId, {
          name: server.providerName,
          baseUrl: server.client.apiBaseUrl,
          api: API_TYPE,
          apiKey: this.settings.resolveApiKey(url, server.config.id),
          models: server.piModels().map(toLegacyModelConfig),
        });
      }
      this.registered.add(server.providerId);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (/duplicate|already registered|one provider/i.test(message)) {
        // The host took the first server and refuses the rest. Say which one
        // is actually in use - the rejected one is the least useful answer.
        this.singleProviderHost = true;
        this.skipped.add(server.providerId);
        warnings.push(this.singleProviderWarning(server));
        return;
      }
      // Anything else is a host that does not want this registration: let
      // {@link ensureRegistered} try the other form before giving up loudly.
      throw error;
    }
  }

  /** Which server a one-provider host is using, said once per skipped server. */
  private singleProviderWarning(skipped: StrataServer): string {
    const inUse = [...this.servers.values()].find((server) => this.registered.has(server.providerId));
    return (
      `${skipped.url} is not registered: this host mounts one provider per session, ` +
      `so only ${inUse?.url ?? "the first server"} is in use`
    );
  }

  /**
   * Check that the host really took the registration, and fix it if not.
   *
   * Registration is a promise until something reads it back. A bridge that
   * ignores the form we used (or accepts it and drops it) shows up as a
   * provider missing from the model registry, which is what this looks for: it
   * switches to the plain `(name, config)` form and registers again. Called on
   * `session_start`, when a registry exists to ask.
   *
   * @returns true when something was re-registered
   */
  async ensureRegistered(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
    const candidates = [...this.servers.values()].filter(
      // A server with no models is invisible in a model list by definition,
      // and one this host deliberately skipped is not a missing registration.
      (server) => server.models.length > 0 && !this.skipped.has(server.providerId),
    );
    if (candidates.length === 0) return false;

    const visible = candidates.filter((server) => this.isVisible(ctx, server.providerId));
    if (visible.length === candidates.length) return false;

    // Some were taken and some were not: the registration form works, and the
    // rest were skipped for a reason that has already been reported.
    if (visible.length > 0) return false;

    if (this.mode === "native") {
      // Nothing we registered is in the registry, so this host does not want
      // that form. Try the plain one before saying anything is wrong.
      this.mode = "legacy";
      this.registered.clear();
      this.skipped.clear();
      this.registerAll(pi);
      const stillMissing = candidates.filter((server) => !this.isVisible(ctx, server.providerId));
      if (stillMissing.length === 0) return true;
      return this.reportMissing(ctx, stillMissing);
    }
    return this.reportMissing(ctx, candidates);
  }

  /**
   * Whether the host's model registry knows this provider.
   *
   * Pi answers `getRegisteredProviderIds` directly; another host may only offer
   * the model list, or neither. A question that cannot be asked is answered
   * "yes" on purpose: switching forms on a guess would be worse than leaving a
   * working registration alone.
   */
  private isVisible(ctx: ExtensionContext, providerId: string): boolean {
    const registry = ctx.modelRegistry as unknown as {
      getRegisteredProviderIds?: () => string[];
      getAll?: () => { provider: string }[];
    };
    try {
      const ids = registry.getRegisteredProviderIds?.();
      if (Array.isArray(ids)) return ids.includes(providerId);
      const models = registry.getAll?.();
      if (Array.isArray(models)) return models.some((model) => model.provider === providerId);
    } catch {
      // Fall through: nothing could be read.
    }
    return true;
  }

  /** Say once that a host took no registration, and that /strata still works. */
  private reportMissing(ctx: ExtensionContext, missing: StrataServer[]): boolean {
    if (this.warnedMissing) return false;
    this.warnedMissing = true;
    ctx.ui.notify(
      `This host did not register the Strata provider ` +
        `(${missing.map((server) => server.providerId).join(", ")}).\n` +
        `Its models will not appear in the model list; /strata can still browse and load them.`,
      "warning",
    );
    return false;
  }

  /** Drop a server from the registry and Pi without touching the settings. */
  forget(pi: ExtensionAPI, url: string): void {
    const server = this.servers.get(url);
    if (!server) return;
    this.servers.delete(url);
    pi.unregisterProvider(server.providerId);
    this.registered.delete(server.providerId);
  }
}

function sameConfig(current: StrataServerConfig, next: StrataServerConfig): boolean {
  return (
    current.id === next.id &&
    current.name === next.name &&
    current.startCommand === next.startCommand &&
    current.stopCommand === next.stopCommand &&
    current.overrides === next.overrides
  );
}

export function createRegistry(settings: StrataSettingsManager): StrataRegistry {
  return new StrataRegistry(settings);
}
