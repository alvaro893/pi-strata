import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { API_TYPE } from "./constants.ts";
import { StrataSettingsManager } from "./settings.ts";
import { type StrataModel, StrataServer } from "./server.ts";
import type { StrataServerConfig } from "./types.ts";

/** A model plus the server that serves it. */
export interface LocatedModel {
  server: StrataServer;
  model: StrataModel;
}

/**
 * The Strata servers Pi is connected to, kept in sync with Pi's provider
 * registry. Each server is one provider, so Pi's own model picker shows
 * `Strata (<url>) / <model>` per server, exactly like the llama.cpp extension
 * does per llama.cpp server.
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
   * Re-read the configuration, probe every server and register the providers.
   *
   * @returns Warnings worth showing to the user
   */
  async update(pi: ExtensionAPI): Promise<string[]> {
    const warnings = [...this.settings.takeWarnings()];
    const timeout = await this.settings.resolveServerTimeout();
    const configs = await this.settings.resolveServers();

    // Reuse the existing object per URL: a load in flight keeps its state.
    const next = new Map<string, StrataServer>();
    for (const config of configs) {
      if (next.has(config.url)) continue; // duplicate URL: one provider per address
      const existing = this.servers.get(config.url);
      const server =
        existing && sameConfig(existing.config, config)
          ? existing
          : new StrataServer(
              config,
              this.settings.resolveApiKey(config.url, config.id),
              this.settings,
            );
      next.set(config.url, server);
    }
    this.servers = next;

    await Promise.all([...this.servers.values()].map((server) => server.refresh(timeout)));

    for (const server of this.servers.values()) {
      this.register(pi, server, warnings);
    }

    // Forget providers whose server disappeared from the configuration.
    for (const id of [...this.registered]) {
      if (![...this.servers.values()].some((server) => server.providerId === id)) {
        pi.unregisterProvider(id);
        this.registered.delete(id);
      }
    }

    for (const server of this.servers.values()) {
      // An unauthorized server is reported by register() with the /login hint.
      const error = server.probeError;
      if (error && error.kind !== "unauthorized") warnings.push(error.message);
    }
    return warnings;
  }

  /**
   * Register one server as a Pi provider.
   *
   * A server that needs a key is registered with an empty model list on
   * purpose: the provider then shows up in `/login`, which is where the user
   * can supply it. An unreachable server is not registered at all.
   */
  register(pi: ExtensionAPI, server: StrataServer, warnings: string[] = []): void {
    const error = server.probeError;
    const models: ProviderModelConfig[] = server.models.map((model) => server.toProviderConfig(model));

    if (error && error.kind !== "unauthorized") {
      if (this.registered.has(server.providerId)) {
        pi.unregisterProvider(server.providerId);
        this.registered.delete(server.providerId);
      }
      return;
    }

    if (error?.kind === "unauthorized")
      warnings.push(
        `${server.url} needs an API key: run /login and choose ${server.providerName}, ` +
          "or store the key in auth.json under this extension's provider id",
      );

    pi.registerProvider(server.providerId, {
      name: server.providerName,
      baseUrl: server.client.apiBaseUrl,
      api: API_TYPE,
      apiKey: this.settings.resolveApiKey(server.url, server.config.id),
      models,
      // Ask the server again instead of showing a stale model list.
      refreshModels: async () => {
        await server.refresh(5000);
        return server.models.map((model) => server.toProviderConfig(model));
      },
    });
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
