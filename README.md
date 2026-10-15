# pi-strata

A [Pi](https://github.com/badlogic/pi-mono) extension for [Strata](https://github.com/Niko1221/Strata):
connect Pi to a Strata server, browse the model it serves, load it, unload it,
and see what state it is in - all from Pi's command palette.

It does for Strata what the `pi-llama-cpp` extension does for llama.cpp: the
model appears in `/model` with the right context window, vision and thinking
support, and `/strata` gives you the browser, the loader and the status line.

Works under **Pi**, under [**oh-my-pi**](https://github.com/can1357/oh-my-pi)
(`omp`) - a fork of Pi with a different extension API - and, through the
[pi2dsh](https://github.com/weijiafu14/pi2dsh) compatibility engine, under
[**DeepSeek Harness**](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
See [Hosts](#hosts). Unofficial: not affiliated with Strata, Pi, oh-my-pi, or
DeepSeek.

## What it does

- **Registers each Strata server as its own Pi provider** (`Strata (<url>) / <model>`),
  with the context window, input modalities and thinking levels read from the server.
- **`/strata`** - model browser with live status icons, switch / load / unload / info,
  plus servers, settings and Strata's own run-config editor.
- **Loads on selection** - picking a Strata model in `/model` takes it into memory
  (unless the server wakes it by itself).
- **Unload frees the machine** - VRAM and pinned RAM go back without touching the server.

## Install

```bash
# Pi
pi -e git:github.com/alvaro893/pi-strata          # try it for one run
pi install git:github.com/alvaro893/pi-strata     # install it
pi install git:github.com/alvaro893/pi-strata@v0.3.0   # pin a release

# oh-my-pi
omp plugin link /path/to/pi-strata                # from a checkout
omp install github:alvaro893/pi-strata            # from GitHub

# DeepSeek Harness, through the pi2dsh compatibility engine
dsh plugin --profile web add pi2dsh
dsh plugin --profile web add github:alvaro893/pi-strata   # or a checkout path
dsh plugin --profile web add /path/to/pi-strata           # (this is what was measured)
```

The host clones the repository and loads `src/index.ts` directly (it is
TypeScript, there is no build step). `pi list` / `omp plugin list` show it, and
`pi update --extensions` reconciles it after a `git pull` or a new tag.

Requires Pi 1.1.0 or newer: verified against Pi 1.1.0 and 1.2.0 with Strata
0.1.43.1, oh-my-pi 18.8.9, and pi2dsh 0.26.0 on DeepSeek Harness 0.2.0-rc.2.

Then connect it to your server:

```text
/strata connect        # both hosts: asks for the URL, then the API key
/login                 # Pi only: choose Strata, then answer the same two prompts
```

```text
Strata server URL: 192.0.2.10:8081          (a bare host:port is fine)
API key (leave empty for a server started without one): ****
```

The address may be written `192.0.2.10:8081`, `http://192.0.2.10:8081`, or
with a pasted `/v1` on the end; plain HTTP is assumed without a scheme.

The extension checks the pair against the server before storing it, and keeps
both in one credential (`strata-server` in `auth.json`), so there is no
environment variable to set.

Prefer configuration files, or run several servers? Both work, and `/strata
servers` writes this for you:

```jsonc
// .pi/settings.json (project) or ~/.pi/agent/settings.json (global)
{
  "strataSettings": {
    "servers": [
      { "url": "http://127.0.0.1:8080", "name": "workstation" }
    ]
  }
}
```

```bash
export STRATA_SERVER_URL=http://127.0.0.1:8080   # one or more, ';' separated
export STRATA_API_KEY=...                        # optional
```

A configured address is used as it is written; `/login` supplies the key (and
the address, when nothing else gives one).

## API key

Strata answers every request when it runs without an `api_key`, and then the
`/login` key prompt can be left empty. Otherwise the key comes from the first of:

1. what `/login` stored (`auth.json`, provider id `strata-server` or your own `id`)
2. `STRATA_API_KEY`
3. the `apiKey` of a `models.json` provider pointed at the same address - so a
   hand-written provider for this server keeps working unchanged

Key values support Pi's usual forms: a literal, `$ENV_VAR` / `${ENV_VAR}`, or
`!command` to fetch it.

`/login` asks for the URL first, so it also works as the only configuration: the
address travels inside the credential.

## Commands

| Command | What it does |
| --- | --- |
| `/strata` | Model browser: switch, load, unload, info, servers, settings, run config |
| `/strata load` | Load the model Pi is on right now |
| `/strata unload` | Unload it and free the VRAM |
| `/strata status` | Reachability, model, context, engine, VRAM, timings per server |
| `/strata servers` | Add, edit, remove servers (then `/login` for its key) |
| `/strata settings` | This extension's behaviour |
| `/strata config` | Edit Strata's run config through the server's own Settings endpoint |
| `/strata refresh` | Probe again and re-register the models |

Status icons: 🟢 loaded · 🔵 sleeping (wakes on the next request) · ⚪ unloaded ·
🟡 loading · 🔴 failed or unreachable · ⛔ needs an API key.

## One server, one model

A Strata process serves exactly one model - that is its design, not this
extension's. To use several installed models, run one server per model on its
own port and list them all:

```jsonc
{
  "strataSettings": {
    "servers": [
      { "url": "http://127.0.0.1:8080", "name": "iq4_xs", "startCommand": "nohup ./run-iq4_xs.sh >/tmp/strata-iq4_xs.log 2>&1 &" },
      { "url": "http://127.0.0.1:8081", "name": "iq2_xs", "startCommand": "nohup ./run-iq2_xs.sh >/tmp/strata-iq2_xs.log 2>&1 &" }
    ]
  }
}
```

Each becomes its own provider, so `/model` shows both and switching between them
loads the other one. `startCommand` (optional) is offered as a "Start server"
action when a server is down; unloading is usually enough to give the GPU back.
Anything that fronts several models (llama-swap and friends) works too - point
one entry at its address.

## Settings

```jsonc
{
  "strataSettings": {
    "servers": [
      {
        "url": "http://127.0.0.1:8080",
        "name": "workstation",              // shown as "Strata (workstation)"
        "id": "strata-local",               // provider id + auth.json key
        "startCommand": "nohup ./run.sh &",  // optional
        "stopCommand": "pkill -f strata",    // optional
        "overrides": {
          // keyed by model id prefix (longest match wins)
          "qwen3.8-flash-next": {
            "contextSize": 262144,
            "maxTokens": 16384,
            "capabilities": ["text"],
            "reasoning": true,
            "cost": { "input": 0, "output": 0 },
            "compat": { "supportsReasoningEffort": true }
          }
        }
      }
    ],
    "reactToModelSelect": true,   // load the model when it is picked
    "autoloadOnMessage": false,   // load before the first message instead of letting the request wait
    "showServerUrls": true,       // show which server a model belongs to
    "serverTimeout": 2000,        // ms for health/status reads
    "loadTimeout": 900000,        // ms to wait for a load (Strata reads 35-55 GB: 1-3 min)
    "reasoningBudgets": {}        // e.g. { "low": 1024, "medium": 4096, "high": 16384 }
  }
}
```

`reasoningBudgets` is off by default: Strata's `reasoning_effort` levels already
set the thinking length. When you set it, the matching value is sent as
`reasoning_budget_tokens` alongside the effort level. On dsh it is not sent at
all: the host carries the request, and `before_provider_request` does not fire
for a route the host owns (measured: `reasoning_effort` present,
`reasoning_budget_tokens` absent).

`maxTokens` defaults to the smaller of the context window and 32768. Strata
shortens `max_tokens` itself when the prompt would not fit (`fit_max_tokens`),
so offering the whole window for one answer only invites runaways.

## Hosts

|  | Pi | oh-my-pi | DeepSeek Harness (via pi2dsh) |
| --- | --- | --- | --- |
| provider registration | a native `Provider`, or `(name, config)` | `(name, config)` | `(name, config)` - and only that, see below |
| interactive setup | `/login` or `/strata connect` | `/strata connect` | `/strata connect` (for this extension's own calls) |
| config dir | `.pi` | `.omp` | `$DSH_HOME/pi2dsh/agent` |
| url-based provider id | `strata-server=http://host:8081` | `strata-server=host-8081` | `strata-server-host-8081` |
| who carries the request | Pi, with our `compat` flags | Pi, with our `compat` flags | dsh's own `llm-pi-ai` adapter, with the same flags translated to it |
| models refresh | Pi re-reads them itself | the extension re-registers after a load, unload or connect | the same |

oh-my-pi's extension API is close to Pi's - `pi.on`, `registerCommand`,
`ctx.ui.*`, `ctx.modelRegistry`, `getAgentDir`, `readStoredCredential` and the
`model_select` / `before_provider_request` events all exist there - but it takes
no native provider, has no `/login` hook, and resolves `--model` itself, which is
why provider ids lose their colons there. Those differences are found in
`src/host.ts`.

A bridge that does not say what it is stays undetectable from an export, so
registration is never only conditional on knowing the host: the extension
registers, then asks the model registry what it actually holds on
`session_start`. If nothing of ours is in it, it registers again in the plain
`(name, config)` form; if that fails too, it says so once instead of leaving the
user with a silently empty model list. A host that refuses a second provider in
one session is detected the same way, and the servers it cannot take are named.

### DeepSeek Harness

`dsh` is not a Pi fork: it is DeepSeek's own Cordis-based harness with a
different plugin architecture. Pi extensions reach it through a compatibility
engine, and [pi2dsh](https://github.com/weijiafu14/pi2dsh) is the one that
implements the surface this extension needs.

```bash
dsh plugin --profile web add pi2dsh
dsh plugin --profile web add <this package>
# then restart dsh - plugins mount at startup
```

**Verified on pi2dsh 0.26.0 with dsh 0.2.0-rc.2** (`npm run live:dsh` builds a
temp `DSH_HOME`, installs the engine and this checkout, and answers one
`dsh headless` task through a Strata-shaped server). What that measurement
changed:

- **`(name, config)`, never a native `Provider`.** The bridge *accepts* one and
  announces `registered as a native DSH llm route`, which looks like success and
  is not: it reads a `Provider` as "this package owns the transport", while the
  `pi-ai/compat` it hands us is its own shim, whose transport needs an active
  Agent runtime - which a route invocation is not. The model appears, is
  selectable, and the first turn dies with `pi2dsh: pi-ai streamSimple() needs a
  DSH llm service`. The `(name, config)` form is translated into dsh's official
  `llm-pi-ai` profile and dsh carries the request, `compat` and reasoning levels
  included.
- **The provider id is folded to `strata-server-127-0-0-1-8081`.** dsh stores a
  route's key under a record id matching `/^[a-z][a-z0-9-]*$/`; with a URL in the
  id it answers `provider id "..." cannot address a stored credential record`
  and the environment is the only way left to authenticate.
- **A turn's key comes from the host, not from `auth.json`.** The bridge keeps
  only an environment reference out of the key we pass, so when
  `STRATA_API_KEY` is set it travels as `$STRATA_API_KEY` and dsh resolves it per
  request; when it is not, dsh uses a key stored in its own Models page under
  that provider id. A literal key is dropped - measured: every turn failed `No
  API key for provider` until the key travelled one of those two ways.
  `/strata connect` still matters, for this extension's own calls (probe, status,
  load, unload), which do read `auth.json`.
- **dsh keeps the result as configuration.** The translation is written into the
  profile's `cordis.patch.yml` as an `llm-pi-ai` provider entry - `api`,
  `baseURL`, `apiKeyEnv`, and each model with its context window, modalities,
  `compat` and reasoning levels. It outlives the session, so a server that moves
  or disappears leaves its entry behind there.
- **dsh is not a one-provider host.** It takes one registration per package slot
  and merges a re-registration; this extension is mounted twice (an anchor and
  the package) and both registrations land.
- **`reasoningBudgets` do not apply.** `before_provider_request` fires only for a
  transport the package owns, and here dsh owns it: the request that was logged
  carried `reasoning_effort: "medium"` and no `reasoning_budget_tokens`. The
  thinking *level* travels (the `reasoningEfforts` map is part of the translated
  profile); the per-level token budget does not.

Not verified: the interactive `/strata` browser on dsh's web or TUI surfaces -
only `dsh headless` was run, where there is nothing to draw. pi2dsh pins its Pi
semantics to 0.84.1 while this extension is built against Pi 1.1/1.2; nothing in
what this extension uses noticed the difference.

## How it talks to Strata

| Endpoint | Used for |
| --- | --- |
| `GET /health` | reachability, model, context, vision, loaded (the only endpoint without a key) |
| `GET /v1/models` | the model and its aliases |
| `GET /v1/status` | loaded / auto_load, engine, VRAM, activity, timings |
| `GET /props` | sleeping state, autoload capability, build info |
| `POST /load`, `POST /unload` | take the model, or give the memory back (both need minutes, not milliseconds) |
| `GET /config`, `POST /config` | Strata's Settings view of the run config |

The models Pi knows come from a probe at extension load plus Pi's own catalog
refresh (which happens in interactive sessions, or with `pi update models`), so
a model appears in `/model` as soon as a server answers.

Two Strata details the extension handles:

- While a model is unloaded and the server cannot load it on demand,
  `/v1/models` returns an empty list - the model is then taken from `/health`,
  so it stays selectable and loadable.
- `/load` and `/unload` answer only for "Strata's own page or a client that is
  no browser": they need `Content-Type: application/json` and reject a foreign
  `Origin`. Node's `fetch` sends no `Origin`, which is why the extension may
  not send one either.

The OpenAI compatibility flags are set from what the endpoint really does:
`max_tokens` (not `max_completion_tokens`), `developer` folded into `system`,
no `store`, and `reasoning_content` replayed on assistant messages - Strata's
prefix cache depends on the exact thinking text, so replaying it keeps the
cache warm between turns.

## Development

```bash
# once: make Pi's own packages resolvable for `tsc` (jiti resolves them the same way at runtime)
mkdir -p node_modules/@earendil-works
ln -s <pi-install>/@earendil-works/pi-coding-agent              node_modules/@earendil-works/
ln -s <pi-install>/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/
ln -s <pi-install>/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/
npm install   # typescript + @types/node

npx tsc --noEmit    # types against the installed Pi packages
npm test            # smoke test against a stand-in Strata server (no real server needed)
STRATA_SERVER_URL=http://host:port STRATA_API_KEY=... LOAD=1 node test/live.mjs
npm run live:dsh    # a real DeepSeek Harness: temp DSH_HOME, pi2dsh, this checkout
```

`test/live.mjs` is read-only unless `LOAD=1`, in which case it loads and
unloads the model once; `RELOAD=1` loads it again at the end. Allow a couple of
minutes: measured at 10-20 s to unload and about 95 s to load a 35 GB IQ4_XS
pack.

`test/live-dsh.mjs` needs node 22.19+, `pnpm` (dsh installs plugins with it) and
network. It writes nothing outside a temp `DSH_HOME`, and ends by checking that
one `dsh headless` task was answered by the Strata server. `DSH_VERSION` and
`PI2DSH_VERSION` pin what it installs.

To check oh-my-pi without a session, note that it logs extension load failures
rather than showing them:

```bash
omp --mode rpc <<< '{"id":"1","type":"get_state"}'   # then read the log
tail -F ~/.omp/logs/omp.$(date +%F).*.log | grep -i "extension"
```

`test/proxy.mjs` is a logging reverse proxy for checking the wire format
against a real server:

```bash
node test/proxy.mjs http://192.0.2.10:8081 8099 /tmp/proxy.log &
STRATA_SERVER_URL=http://127.0.0.1:8099 pi -e ./src/index.ts --thinking high \
  --model 'strata-server=http://127.0.0.1:8099/<model>' "hi"
```
