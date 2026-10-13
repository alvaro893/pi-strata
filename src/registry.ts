import type { ApiKeyCredential } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { createStrataProvider, credentialUrl } from "./provider.ts";
import { StrataSettingsManager } from "./settings.ts";
import { type StrataModel, StrataServer } from "./server.ts";
import type { StrataServerConfig } from "./types.ts";

/** A model plus the server that serves it. */
export interface LocatedModel {
  server: StrataServer;
  model: StrataModel;
}

/**
 * The Strata servers Pi is connected to.
 *
 * Every server is registered as its own **native** Pi provider, which is what
 * lets `/login` ask for its URL and API key (see `createStrataProvider`). With
 * nothing configured the extension still registers one empty provider, so
 * `/login` has an entry to fill in: no environment variable is required.
 */
export class StrataRegistry {
  private servers = new Map<string, StrataServer>();

  /** Provider IDs this extension registered, to forget removed servers. */
  private readonly registered = new Set<string>();

  constructor(private readonly settings: StrataSettingsManager) {}

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
        const credential = readStoredCredential(server.providerId) as ApiKeyCredential | undefined;
        const url = credentialUrl(credential) ?? server.config.url;
        if (url) server.useUrl(url);
        server.useApiKey(
          credential?.key ?? (url ? this.settings.resolveApiKey(url, server.config.id) : ""),
        );

        // Probe before registering: the provider is seeded with what the probe
        // found, so the models exist before Pi's first catalog snapshot.
        if (url) await server.refresh(timeout);
        this.register(pi, server, warnings);
      }),
    );

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

  /** Register one server as a native Pi provider. */
  register(pi: ExtensionAPI, server: StrataServer, warnings: string[] = []): void {
    if (server.probeError?.kind === "unauthorized" && server.config.url)
      warnings.push(
        `${server.url} refused the API key (or has none): ` +
          `run /login, choose ${server.providerName}, and enter the key it expects`,
      );

    pi.registerProvider(createStrataProvider(server, (url) => this.settings.resolveApiKey(url)));
    this.registered.add(server.providerId);
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
