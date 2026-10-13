import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPath: join(process.cwd(), "tsconfig.json") });
const { StrataRegistry } = await jiti.import("../src/registry.ts");
const { StrataSettingsManager } = await jiti.import("../src/settings.ts");

const settings = new StrataSettingsManager();
const registry = new StrataRegistry(settings);
const registered = [];
const pi = {
  registerProvider: (provider) => registered.push(provider),
  unregisterProvider: () => {},
  on: () => () => {}, registerCommand: () => {},
};
const warnings = await registry.update(pi);
console.log("warnings:", warnings.length ? warnings : "none");
for (const provider of registered) {
  console.log(`provider ${provider.id}: configured via`, provider.auth.apiKey ? "apiKey auth" : "none");
  const check = await provider.auth.apiKey.check({ ctx: { env: async (n) => process.env[n], fileExists: async () => false } });
  console.log("  check:", check);
  const resolved = await provider.auth.apiKey.resolve({ ctx: { env: async (n) => process.env[n], fileExists: async () => false } });
  console.log("  resolve:", resolved && { baseUrl: resolved.auth.baseUrl, key: resolved.auth.apiKey?.slice(0, 6) + "...", source: resolved.source });
  const published = [];
  await provider.refreshModels({
    credential: undefined, stored: undefined, allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (p) => { published.push(p); p.update?.(); return true; },
  });
  console.log("  published:", published.length, "models:", provider.getModels().map((m) => m.id));
}
