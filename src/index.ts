import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_PREFIX } from "./constants.ts";
import { createRegistry, type StrataRegistry } from "./registry.ts";
import { createSettingsManager } from "./settings.ts";
import {
  browseModels,
  connectServer,
  editRunConfig,
  editSettings,
  loadModel,
  manageServers,
  refresh,
  showStatus,
  unloadModel,
} from "./ui.ts";
const SUBCOMMANDS: { value: string; label: string; description: string }[] = [
  { value: "connect", label: "connect", description: "Enter a server URL and its API key" },
  { value: "status", label: "status", description: "Reachability, model, VRAM and timings per server" },
  { value: "servers", label: "servers", description: "Add, edit or remove Strata servers" },
  { value: "settings", label: "settings", description: "Behaviour of this extension" },
  { value: "config", label: "config", description: "Edit Strata's run config through the server" },
  { value: "refresh", label: "refresh", description: "Probe the servers and re-register the models" },
  { value: "load", label: "load", description: "Load the model Pi is on right now" },
  { value: "unload", label: "unload", description: "Unload it and free the VRAM" },
];

/**
 * Connect Pi to a Strata server (https://github.com/Niko1221/Strata): browse the
 * model it serves, load it, unload it, and see what state it is in - from the
 * command palette, the way the llama.cpp extension does it for llama.cpp.
 *
 * A Strata process serves one model, so each configured server (one per
 * installed model, or one address in front of several) becomes its own Pi
 * provider: `Strata (<url>) / <model>`.
 */
export default async function (pi: ExtensionAPI) {
  const settings = createSettingsManager();
  const registry = createRegistry(settings);

  // Register the providers while the extension loads, so the models are in
  // place before the first prompt.
  const warnings = await registry.update(pi);

  pi.on("session_start", async (_event, ctx) => {
    for (const warning of warnings) ctx.ui.notify(warning, "warning");
  });

  // Picking a Strata model in Pi's model picker takes the model into memory,
  // unless the server wakes it on its own.
  pi.on("model_select", async (event, ctx) => {
    if (!event.model.provider.startsWith(PROVIDER_PREFIX)) return;
    if (!(await settings.resolveReactToModelSelect())) return;
    if (!ctx.hasUI) return;

    const located = registry.getServerForModel(event.model.id);
    if (!located) return;

    // Look again before deciding: the model may have been unloaded by another
    // client, by Strata's own idle timer, or from its page, and a stale
    // "loaded" would skip the load the selection asked for.
    await located.server.refresh(await settings.resolveServerTimeout());

    const kind = located.server.statusOf(located.model);
    if (kind === "loaded" || kind === "sleeping" || kind === "loading") return;

    await loadModel(ctx, located.server, located.model);
    // What a server offers changes with its state (aliases appear once the
    // model is in memory), and oh-my-pi needs the provider registered again to
    // see that - Pi would refresh on its own.
    await syncCatalog(pi, ctx, registry);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    // The event carries only the request payload; its `model` says who it is for.
    const payload = event.payload as
      | { model?: string; reasoning_effort?: string; reasoning_budget_tokens?: number }
      | undefined;
    if (!payload?.model) return undefined;

    const located = registry.getServerForModel(payload.model);
    if (!located) return undefined;

    // Optionally warm the model up instead of letting the first token wait for it.
    // Off by default: Strata loads on the first request by itself when it can.
    if ((await settings.resolveAutoloadOnMessage()) && ctx.hasUI) {
      const kind = located.server.statusOf(located.model);
      if (kind !== "loaded" && kind !== "sleeping" && kind !== "loading")
        await loadModel(ctx, located.server, located.model);
    }

    // Strata caps thinking length with `reasoning_budget_tokens`; send it only
    // when the user mapped Pi's thinking levels to token budgets.
    const budgets = await settings.resolveReasoningBudgets();
    const level = ctx.thinkingLevel ?? (await settings.getThinkingLevel()) ?? "medium";
    const budget = budgets[level];
    if (
      typeof budget === "number" &&
      budget > 0 &&
      payload.reasoning_budget_tokens === undefined &&
      payload.reasoning_effort !== "none"
    )
      return { ...payload, reasoning_budget_tokens: budget };

    return undefined;
  });

  pi.registerCommand("strata", {
    description: "Connect to a Strata server: model browser, load and unload",
    getArgumentCompletions: (argumentPrefix: string) => {
      const typed = argumentPrefix.replace(/^\//, "");
      const filtered = SUBCOMMANDS.filter((item) => item.value.startsWith(typed));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = (args ?? "").trim();
      const sub = trimmed.split(/\s+/)[0]?.toLowerCase().replace(/^\//, "") ?? "";

      // A read-only path that needs no dialogs, so it also works when the
      // caller has no UI (RPC, or a future non-interactive dispatch).
      if (sub === "status") {
        showStatus(ctx, registry);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/strata needs an interactive session", "warning");
        return;
      }

      switch (sub) {
        case "":
          await browseModels(pi, ctx, registry, settings);
          await syncCatalog(pi, ctx, registry);
          break;
        case "connect":
          await connectServer(pi, ctx, registry, settings);
          break;
        case "servers":
          await manageServers(pi, ctx, registry, settings);
          break;
        case "settings":
          await editSettings(ctx, settings);
          break;
        case "config":
          await editRunConfig(pi, ctx, registry);
          break;
        case "refresh":
          await refresh(pi, ctx, registry);
          break;
        case "load":
          await currentModelAction(ctx, "load");
          await syncCatalog(pi, ctx, registry);
          break;
        case "unload":
          await currentModelAction(ctx, "unload");
          await syncCatalog(pi, ctx, registry);
          break;
        default:
          ctx.ui.notify(
            `Unknown /strata argument '${trimmed}'. Try: ${SUBCOMMANDS.map((item) => `/${item.value}`).join(" ")}`,
            "warning",
          );
      }
    },
  });

  /** `/strata load|unload` for the model Pi is on right now. */
  const currentModelAction = async (
    ctx: ExtensionCommandContext,
    action: "load" | "unload",
  ): Promise<void> => {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model selected", "warning");
      return;
    }
    const located = registry.getServerForModel(model.id);
    if (!located) {
      ctx.ui.notify(`${model.id} is not a Strata model - /model first, or /strata to browse`, "warning");
      return;
    }
    if (action === "load") await loadModel(ctx, located.server, located.model);
    else await unloadModel(ctx, located.server, located.model);
  };
}

/** Re-probe and re-register without announcing it, unless something is wrong. */
async function syncCatalog(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  registry: StrataRegistry,
): Promise<void> {
  const warnings = await registry.update(pi);
  for (const warning of warnings) ctx.ui.notify(warning, "warning");
}
