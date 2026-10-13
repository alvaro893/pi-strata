import type {
  AnyModel,
  ApiKeyCredential,
  AuthContext,
  Credential,
  Provider,
  ProviderAuth,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { StrataClient, normalizeRoot } from "./client.ts";
import { API_KEY_PLACEHOLDER, DEFAULT_URL, PROVIDER_NAME } from "./constants.ts";
import type { StrataServer } from "./server.ts";
import type { StrataPiModel } from "./types.ts";

/** Only api-key credentials carry a Strata server URL (in `env`). */
export function credentialUrl(credential: Credential | undefined): string | undefined {
  if (credential?.type !== "api_key") return undefined;
  const value = credential.env?.STRATA_SERVER_URL;
  return typeof value === "string" && value.trim() ? normalizeRoot(value) : undefined;
}

/**
 * Which server a provider talks to: what `/login` stored wins, then the address
 * this provider was configured with (settings or `STRATA_SERVER_URL`).
 * undefined = nothing configured yet, so Pi shows the provider as unconfigured
 * and `/login` is the way to set it.
 */
function resolveUrl(server: StrataServer, credential: Credential | undefined): string | undefined {
  const fromLogin = credentialUrl(credential);
  if (fromLogin) return fromLogin;
  return server.config.url ? normalizeRoot(server.config.url) : undefined;
}

/**
 * Point the server object at the effective address and key, so the model
 * browser and the running catalog never disagree with the credential.
 */
function applyCredential(server: StrataServer, credential: Credential | undefined): void {
  const url = resolveUrl(server, credential);
  if (!url) return;
  server.useUrl(url);
  if (credential?.type === "api_key" && credential.key) server.useApiKey(credential.key);
}

/**
 * The api-key auth of one Strata server.
 *
 * `login` is the part that answers the user's need: it asks for the server URL
 * *and* the key (like `/login llama.cpp` does), proves the pair works against
 * the server before storing it, and keeps the URL in the credential's `env`.
 */
function strataAuth(server: StrataServer, apiKeyFallback: (url: string) => string): ProviderAuth {
  return {
    apiKey: {
      name: `${PROVIDER_NAME} server`,
      login: async (interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> => {
        const known = resolveUrl(server, undefined);
        const entered = await interaction.prompt({
          type: "text",
          message: "Strata server URL",
          placeholder: known ?? process.env.STRATA_SERVER_URL ?? DEFAULT_URL,
        });
        const url = normalizeRoot(entered.trim() || known || process.env.STRATA_SERVER_URL || DEFAULT_URL);

        const key = (
          await interaction.prompt({
            type: "secret",
            message: "API key (leave empty for a server started without one)",
            placeholder: "optional",
          })
        ).trim();

        // Prove it before storing anything: a wrong URL or key is worth an
        // error now, not a failed request later.
        const client = new StrataClient(url, key || API_KEY_PLACEHOLDER);
        const health = await client.health(5000).catch((error: Error) => {
          throw new Error(`${url} did not answer: ${error.message}`);
        });
        if (health.service && health.service !== "strata")
          throw new Error(`${url} answers, but it does not look like a Strata server`);
        if (health.api_key && !key)
          throw new Error(`${url} requires an API key; run /login again and enter it`);
        if (key) {
          try {
            await client.models(10_000);
          } catch (error) {
            throw new Error(`the server rejected that API key: ${(error as Error).message}`);
          }
        }

        interaction.notify({
          type: "info",
          message:
            `${url}${health.model ? ` serves ${health.model}` : ""}` +
            `${health.loaded ? " (loaded)" : ""}`,
        });

        // The URL travels in `env`, exactly like the built-in llama.cpp
        // provider, so one credential holds the whole connection.
        return { type: "api_key", key: key || undefined, env: { STRATA_SERVER_URL: url } };
      },
      check: async ({ credential }: { ctx: AuthContext; credential?: ApiKeyCredential }) =>
        resolveUrl(server, credential)
          ? { type: "api_key", source: credential ? "stored with /login" : "configured" }
          : undefined,
      resolve: async ({ ctx, credential }: { ctx: AuthContext; credential?: ApiKeyCredential }) => {
        const url = resolveUrl(server, credential);
        if (!url) return undefined;
        const apiKey =
          credential?.key ||
          (await ctx.env("STRATA_API_KEY"))?.trim() ||
          // A hand-written models.json provider for the same server still works.
          apiKeyFallback(url) ||
          API_KEY_PLACEHOLDER;
        return {
          auth: { apiKey, baseUrl: `${url}/v1` },
          env: { ...credential?.env, STRATA_SERVER_URL: url },
          source: credential?.key ? "stored with /login" : "STRATA_API_KEY",
        };
      },
    },
  };
}

/**
 * A Strata server as a native Pi provider.
 *
 * Native (rather than a provider *config*) because only this shape can ask for
 * the server URL interactively: `auth.apiKey.login` runs on `/login`, and
 * `refreshModels` fetches the catalog from whatever address that credential
 * ended up with.
 */
export function createStrataProvider(
  server: StrataServer,
  apiKeyFallback: (url: string) => string,
): Provider {
  // Seeded from the probe the registry just did, so the models are in Pi's
  // catalog immediately. Pi only refreshes dynamic catalogs in interactive
  // mode (or with `pi update models`), and `-p`/`--list-models` read the
  // in-memory list as it stands - an empty seed would make the model
  // unreachable until the first interactive refresh.
  let models: StrataPiModel[] = server.piModels();

  return {
    id: server.providerId,
    name: server.providerName,
    baseUrl: `${server.url}/v1`,
    auth: strataAuth(server, apiKeyFallback),

    getModels: () => models,

    /**
     * Restore the last known catalog, then read the server again. Called by Pi
     * at startup and when models are refreshed, with the credential it resolved
     * from `/login` or the environment.
     */
    refreshModels: async (context) => {
      if (context.stored?.models?.length) {
        const stored = context.stored.models.filter(
          (model): model is StrataPiModel =>
            model.provider === server.providerId && model.api === "openai-completions",
        );
        if (stored.length > 0)
          await context.publish({ update: () => { models = stored; } });
      }

      const url = resolveUrl(server, context.credential);
      if (!url || !context.allowNetwork || context.signal.aborted) return;

      applyCredential(server, context.credential);
      await server.refresh(await server.settings.resolveServerTimeout());
      if (context.signal.aborted) return;

      const refreshed = server.piModels();
      await context.publish({
        persist: { models: refreshed as readonly AnyModel[], checkedAt: Date.now() },
        update: () => { models = refreshed; },
      });
    },

    // Requests go through the same OpenAI-completions implementation Pi uses
    // for any other compatible server; the per-model `compat` flags above
    // describe what Strata's endpoint actually accepts.
    //
    // The compat entrypoint's option type is wider than the provider interface
    // declares, so the boundary is cast once, deliberately.
    stream: ((...args: Parameters<typeof stream>) => stream(...args)) as Provider["stream"],
    streamSimple: ((...args: Parameters<typeof streamSimple>) => streamSimple(...args)) as Provider["streamSimple"],
  };
}
