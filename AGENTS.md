# Working on pi-strata

A Pi extension that connects to a [Strata](https://github.com/Niko1221/Strata)
server: model browser, load/unload, live status, run-config editor. One package,
three hosts - Pi, [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`), and
(prepared, unverified) DeepSeek Harness through
[pi2dsh](https://github.com/weijiafu14/pi2dsh).

This branch (`dsh-compat`) carries the dsh preparation; `main` does not.

## Commands

```bash
npm run typecheck   # tsc --noEmit, strict, noUnusedLocals-clean
npm test            # smoke test: the real modules against a stand-in server
npm run live        # read-only probe of a real Strata server (env below)
node test/proxy.mjs <upstream-url> <port> <logfile>   # logging reverse proxy
```

CI (`.github/workflows/ci.yml`) installs, typechecks and tests on every push.
A change is not finished until `npm run typecheck` and `npm test` pass and CI is
green.

## There is no build step

Pi loads `src/index.ts` through jiti, so the TypeScript **is** the artifact: do
not add a build output, and keep imports as `./x.ts` (`allowImportingTsExtensions`
is on for the same reason).

The host supplies `@earendil-works/pi-*`. They are `peerDependencies` with `"*"`
and must never move into `dependencies` - a second copy breaks Pi's module
mapping. `tsc` still needs them locally:

```bash
mkdir -p node_modules/@earendil-works
ln -s <pi-install>/@earendil-works/pi-coding-agent node_modules/@earendil-works/
ln -s <pi-install>/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai  node_modules/@earendil-works/
ln -s <pi-install>/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/
npm install
```

Do not commit `package-lock.json`: with `"*"` peers, npm records absolute paths of
whatever Pi install it resolved against.

## Where things live

| file | responsibility |
| --- | --- |
| `src/host.ts` | **the only host-aware file**: agent dir, config dir, settings/auth/models paths, capability flags, provider-id shape |
| `src/client.ts` | HTTP to one server; `normalizeRoot` / `parseServerUrl` |
| `src/server.ts` | one server: probe snapshot, status, load/unload, Pi model shape |
| `src/provider.ts` | native Pi `Provider` (`auth.apiKey.login`, `refreshModels`) and the legacy `(name, config)` shape |
| `src/registry.ts` | server list, probing, adaptive registration |
| `src/settings.ts` | `strataSettings`: read/write, URL and key resolution |
| `src/ui.ts` | `/strata`: browser, connect, servers, settings, run config |
| `src/index.ts` | wiring: events and the `/strata` command |

**Rule:** host differences belong in `src/host.ts` and in the table below.
Nothing else may branch on the host.

## Hosts

|  | Pi | oh-my-pi | dsh (via pi2dsh) |
| --- | --- | --- | --- |
| registration | native `Provider`, or `(name, config)` | `(name, config)` only | both, resolved by the bridge |
| interactive setup | `/login` or `/strata connect` | `/strata connect` | `/strata connect` |
| config dir | `.pi` | `.omp` | Pi's |
| url-based provider id | `strata-server=http://host:8081` | `strata-server=host-8081` | as Pi |
| verified here | yes | yes | **no** |

A Pi-ABI bridge cannot be detected from an export, so registration is *checked*
rather than assumed: at `session_start`, `StrataRegistry.ensureRegistered` looks
at what the host's model registry actually holds. Nothing of ours → register
again as `(name, config)`; still nothing → say so once. A host that mounts one
provider per session (dsh does) is found the same way and its skipped servers are
named. **Do not replace this with a host-name check.**

Measured, not assumed (omp 18.8.9, Pi 1.1.0 and 1.2.0):

- omp's `SettingsManager` has no `reload()` (it has `reloadFromDisk`), its
  `writeValue` throws, and its settings do not live in `settings.json` - which is
  why this extension reads and writes that file itself.
- omp resolves `--model provider/model` itself and stops at a **colon** in the
  provider id: `strata=eqtest` resolves, `strata:colontest` does not. Hence
  `specSafeAddress`.
- omp raises `DUPLICATE_PROVIDER` for a second provider in one session.
- omp writes extension load failures to `~/.omp/logs/omp.<date>.<pid>.log`
  instead of showing them, and needs one usable model before a session starts.

## Strata facts that shaped the code

- `POST /load` does not answer until the model is in memory: **about 95 s** for a
  35 GB IQ4_XS. `/unload` takes seconds to tens of seconds. Both were a 5 s
  timeout once, and both failed.
- `/load`, `/unload` and `/config` answer only for "Strata's own page or a client
  that is no browser": `Content-Type: application/json` and no foreign `Origin`.
  Node's fetch sends no `Origin` - never add one.
- `/health` needs no auth and always names the model. `/v1/models` returns an
  **empty list** while the model is unloaded and the server cannot load on
  demand, so the model is also taken from `/health`. Aliases appear only once the
  model is loaded.
- `/v1/status` reports VRAM under `machine.gpu` (`used_mib`/`total_mib`); `vram`
  is usually just `{elastic: false}`. Timings use llama.cpp names: `prompt_n`,
  `predicted_n`, `cache_n`, `draft_n`/`draft_n_accepted`.
- `max_context` is whatever the server was started with and changes between runs
  (seen as 131072, later 262144): always read it, never assume it.
- A key comes from `auth.json` under the provider id, `STRATA_API_KEY`, or a
  `models.json` provider pointed at the same address. Both hosts use
  `{ "<id>": { "type": "api_key", "key": "...", "env": {...} } }`.
- Strata's prefix cache depends on the exact thinking text, so `compat` replays
  `reasoning_content` on assistant messages and sends `max_tokens` (not
  `max_completion_tokens`).

## Testing

`test/fake-strata.mjs` mirrors the real server, including the own-page check and
the empty model list while unloaded. When a real behaviour surprises you, make
the fake match it and add the assertion to `test/smoke.mjs`.

**Tests must never touch real configuration.** They point `PI_CODING_AGENT_DIR` at
a temp dir and `chdir` into another; anything that writes settings or credentials
has to do the same. (An early version of the suite wrote a `strataSettings` block
into the real `~/.pi/agent/settings.json`.)

Against a real server:

```bash
STRATA_SERVER_URL=http://host:8081 STRATA_API_KEY=... npm run live    # read-only
LOAD=1 RELOAD=1 ... npm run live                                      # unload + load, 2 min
```

`test/proxy.mjs` sits in front of a real server and logs request bodies. That is
how the wire format was confirmed (the `max_tokens` field, `reasoning_effort`
per thinking level, and `reasoning_content` being replayed).

To check an oh-my-pi install, remember it logs instead of failing loudly:

```bash
omp plugin link <checkout>                       # `omp install` needs bun
omp --mode rpc <<< '{"id":"1","type":"get_state"}'
tail -F ~/.omp/logs/omp.$(date +%F).*.log | grep -i extension
```

## Style

- Comments explain **why**, with the measurement or the reason behind it.
- Documentation states what is unverified as unverified. Never describe behaviour
  that has not been run.
- Write nothing to Pi's footer (`ctx.ui.setStatus`); that was removed on request.
- No secrets, keys, LAN addresses or machine paths in committed files.
- Releases are git only: bump `package.json`, push an annotated `vX.Y.Z` tag, and
  keep `main` releasable. Nothing is published to npm.
