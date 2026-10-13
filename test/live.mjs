// Live check against a real Strata server: prints what the extension sees.
//   STRATA_SERVER_URL=http://host:port STRATA_API_KEY=... node test/live.mjs
// Read-only unless LOAD=1 (then it loads and unloads the model).
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPath: join(process.cwd(), "tsconfig.json") });
const { StrataSettingsManager } = await jiti.import("../src/settings.ts");
const { StrataRegistry } = await jiti.import("../src/registry.ts");

const settings = new StrataSettingsManager();
const registry = new StrataRegistry(settings);
const pi = {
  registerProvider: (id, config) => console.log(`\n[provider] ${id}\n${JSON.stringify(config, null, 2).slice(0, 1200).replace(/\n\s*"apiKey": "[^"]*"/g, "")}`),
  unregisterProvider: (id) => console.log(`[unregister] ${id}`),
  on: () => () => undefined,
  registerCommand: () => undefined,
};

const warnings = await registry.update(pi);
console.log(`\n[warnings] ${warnings.length ? "\n" + warnings.join("\n") : "none"}`);

for (const server of registry.getServers()) {
  console.log(`\n[describe]\n${server.describe()}`);
  for (const model of server.models) {
    console.log(`\n[model] ${server.label(model)}\n${server.info(model)}`);
  }
  if (process.env.LOAD === "1" && server.models[0]) {
    const model = server.models[0];
    console.log(`\n[load] ${model.id}`);
    const started = Date.now();
    await server.load(model, (elapsed) => process.stdout.write(`  ${elapsed}s...\r`));
    console.log(`  loaded after ${Math.round((Date.now() - started) / 1000)}s (now ${server.isLoaded()})`);

    console.log(`[unload] ${model.id}`);
    console.log(`  ${await server.unload()}`);
    await server.refresh(5000);
    console.log(`  loaded now: ${server.isLoaded()}`);

    // Leave the server as it was found.
    if (process.env.RELOAD === "1") {
      console.log(`[reload] ${model.id}`);
      await server.load(model, (elapsed) => process.stdout.write(`  ${elapsed}s...\r`));
      await server.refresh(5000);
      console.log(`  loaded again: ${server.isLoaded()}`);
    }
  }
}
