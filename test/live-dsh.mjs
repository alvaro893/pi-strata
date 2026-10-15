// Live check of the third host: this extension, unmodified, inside a real
// DeepSeek Harness through pi2dsh. It builds a throwaway DSH_HOME, installs the
// engine and this checkout into a headless profile, points the extension at a
// fake Strata server, and asks dsh to answer one task with that model.
//
//   npm run live:dsh                 # needs node 22.19+, pnpm and network
//   DSH_VERSION=... PI2DSH_VERSION=... npm run live:dsh
//
// What it proves, in one command: the extension loads under a Pi-ABI bridge, its
// provider reaches dsh's model directory, dsh signs the request with a key from
// its own credential store, and the answer comes back from the Strata server.
//
// Nothing here touches the real ~/.dsh or a real $DSH_HOME: DSH_HOME is a temp
// directory for the whole run.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const DSH_VERSION = process.env.DSH_VERSION ?? "0.2.0-rc.2";
const PI2DSH_VERSION = process.env.PI2DSH_VERSION ?? "pi2dsh";
const REPLY = "strata-was-here";
const API_KEY = "dsh-test-key";
const PROFILE = "headless";

const jiti = createJiti(import.meta.url, { tsconfigPath: join(process.cwd(), "tsconfig.json") });
const { PROVIDER_PREFIX } = await jiti.import("../src/constants.ts");

const dshHome = await mkdtemp(join(tmpdir(), "pi-strata-dsh-"));
const repoRoot = process.cwd();
let strata;

// The provider id has to be the one the extension will actually use, so it is
// computed by the extension's own code under a host that looks like pi2dsh (the
// same shim the smoke test uses) rather than spelled out again here.
const bridgeShim = join(dshHome, "bridge-host.mjs");
writeFileSync(
  bridgeShim,
  `export * from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};\n` +
    `export const VERSION = "pi2dsh-compat";\n`,
  "utf-8",
);
const bridgeJiti = createJiti(import.meta.url, {
  tsconfigPath: join(repoRoot, "tsconfig.json"),
  alias: { "@earendil-works/pi-coding-agent": bridgeShim },
  moduleCache: false,
});
const bridgeHost = await bridgeJiti.import("../src/host.ts");
if (bridgeHost.hostName !== "dsh")
  throw new Error("the bridge shim no longer reads as dsh, so the provider id below is not the one in use");

/**
 * Start the fake Strata server in its own process.
 *
 * It has to be a separate process: dsh is run with `spawnSync` below, which
 * blocks this one, and a server that cannot answer while the extension probes it
 * is a server the extension cannot configure. (Measured: `/health` timed out and
 * the route was never declared.)
 */
async function startStrata() {
  const script = join(dshHome, "strata.mjs");
  writeFileSync(
    script,
    `import { startFakeStrata } from ${JSON.stringify(join(repoRoot, "test", "fake-strata.mjs"))};\n` +
      "const s = await startFakeStrata({ port: 0, apiKey: process.env.FAKE_API_KEY, reply: process.env.FAKE_REPLY, aliases: [], loaded: true });\n" +
      "console.log(s.url);\n" +
      // A safety net: an interrupted run must not leave a server listening.
      "setTimeout(() => process.exit(0), 900000);\n",
    "utf-8",
  );
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, FAKE_API_KEY: API_KEY, FAKE_REPLY: REPLY },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the fake Strata server did not start")), 30_000);
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      const line = chunk.split("\n").find((candidate) => candidate.startsWith("http://"));
      if (line) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the fake Strata server exited with ${code}`));
    });
  });
  return { url, close: () => child.kill("SIGTERM") };
}

/** Run one dsh command in the throwaway home and return everything it printed. */
function dsh(args, { timeout = 600_000, env = {} } = {}) {
  // dsh answers on stdout and explains itself on stderr; both are wanted, and
  // a run that answers nothing still exits, so the exit code is not the signal.
  const run = spawnSync("npx", ["-y", `@deepseek-ai/dsh@${DSH_VERSION}`, ...args], {
    env: { ...process.env, DSH_HOME: dshHome, ...env },
    encoding: "utf-8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ?? ""}`;
}

/** The final text of a `headless --json` run, or undefined when there was none. */
function finalText(out) {
  let text;
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "final") text = event.text;
    } catch {
      // Diagnostics share the stream; anything that is not an event is not a result.
    }
  }
  return text;
}

try {
  console.log(`[dsh ${DSH_VERSION}] home: ${dshHome}`);
  const probe = dsh(["--version"], { timeout: 300_000 });
  if (probe.includes("pnpm was not found"))
    throw new Error("dsh installs plugins with pnpm; install it (npm i -g pnpm) and run again");

  // 1. a Strata server to talk to
  strata = await startStrata();
  const url = strata.url;
  const health = await (await fetch(`${url}/health`)).json();
  // The id dsh will see, computed by the extension's own code for this host -
  // it has to be a legal dsh credential-record id.
  const providerId = bridgeHost.urlProviderId(PROVIDER_PREFIX, url);
  if (!/^[a-z][a-z0-9-]*$/.test(providerId))
    throw new Error(`the provider id this extension would use is not a dsh record id: ${providerId}`);
  console.log(`[strata] ${url} serves ${health.model}; provider id ${providerId}`);

  // 2. the profile: the engine, then this package
  console.log("[install] pi2dsh");
  dsh(["plugin", "--profile", PROFILE, "add", PI2DSH_VERSION]);
  console.log("[install] pi-strata (this checkout)");
  dsh(["plugin", "--profile", PROFILE, "add", repoRoot]);

  // 3. dsh's own configuration: the model to answer with, and its key. The key
  //    goes in dsh's credential store under `llm-pi-ai/<provider id>` - the
  //    route's own store, which is what the id in step 1 makes possible.
  writeFileSync(
    join(dshHome, "profiles", PROFILE, "cordis.patch.yml"),
    `- id: agent-default-model\n  config:\n    provider: '${providerId}'\n    model: '${health.model}'\n`,
    "utf-8",
  );
  const credentials = join(dshHome, ".credentials.yaml");
  writeFileSync(
    credentials,
    `version: 1\nrecords:\n  llm-pi-ai/${providerId}:\n    kind: api-key\n    key: ${API_KEY}\n`,
    { mode: 0o600, encoding: "utf-8" },
  );
  chmodSync(credentials, 0o600); // dsh refuses the file with group or other bits

  // 4. one task, answered by the Strata model. The route is declared while the
  //    extension loads, so the first run can still miss the adapter; a second
  //    run sees the profile the first one wrote.
  let answer;
  for (let attempt = 1; attempt <= 3 && answer !== REPLY; attempt++) {
    const out = dsh(["headless", "--json", "Repeat the word the server gives you."], {
      timeout: 300_000,
      // How the extension learns the address. `/strata connect` writes it to the
      // settings file of the agent dir the bridge redirects; the environment is
      // the same source, and does not depend on where that directory is.
      env: { STRATA_SERVER_URL: url, STRATA_API_KEY: "" },
    });
    answer = finalText(out);
    console.log(`[run ${attempt}] ${answer === undefined ? "no answer" : JSON.stringify(answer)}`);
    if (answer !== REPLY) console.log(out.trim().split("\n").slice(0, 16).join("\n"));
  }

  if (answer !== REPLY)
    throw new Error(
      `dsh did not answer with the Strata server's reply (got ${JSON.stringify(answer)}, want ${JSON.stringify(REPLY)})`,
    );

  console.log(
    `ok - dsh ${DSH_VERSION} + pi2dsh answered "${answer}" through ${providerId} / ${health.model}`,
  );
} finally {
  if (strata) strata.close();
  await rm(dshHome, { recursive: true, force: true });
}
