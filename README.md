# pi-strata

A [Pi](https://github.com/badlogic/pi-mono) extension for [Strata](https://github.com/Niko1221/Strata):
connect Pi to a Strata server, browse the model it serves, load it, unload it,
and see what state it is in - all from Pi's command palette.

It does for Strata what the `pi-llama-cpp` extension does for llama.cpp: the
model appears in `/model` with the right context window, vision and thinking
support, and `/strata` gives you the browser, the loader and the status line.

Unofficial: not affiliated with Strata or Pi.

## What it does

- **Registers each Strata server as its own Pi provider** (`Strata (<url>) / <model>`),
  with the context window, input modalities and thinking levels read from the server.
- **`/strata`** - model browser with live status icons, switch / load / unload / info,
  plus servers, settings and Strata's own run-config editor.
- **Loads on selection** - picking a Strata model in `/model` takes it into memory
  (unless the server wakes it by itself).
- **Status line** - `🟢 qwen3.8-flash-next-iq4_xs · 131K · workstation` in the footer.
- **Unload frees the machine** - VRAM and pinned RAM go back without touching the server.

## Install

```bash
pi install git:github.com/alvaro893/pi-strata    # straight from git
pi -e git:github.com/alvaro893/pi-strata         # try it for one run, without installing
pi install npm:pi-strata                          # once it is on npm
```

Requires Pi 1.1.0 or newer: verified against Pi 1.1.0 and 1.2.0 with Strata 0.1.43.1.

Then connect it to your server: run `/login`, choose **Strata**, and answer two
prompts - the server URL and its API key:

```text
/login
  Strata server URL: http://127.0.0.1:8080
  API key (leave empty for a server started without one): ****
```

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
      { "url": "http://127.0.0.1:8080", "name": "iq4_xs", "startCommand": "nohup ./run-iq4.sh >/tmp/strata-iq4.log 2>&1 &" },
      { "url": "http://127.0.0.1:8081", "name": "iq2_xs", "startCommand": "nohup ./run-iq2.sh >/tmp/strata-iq2.log 2>&1 &" }
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
    "statusLine": true,           // footer status line while a Strata model is active
    "serverTimeout": 2000,        // ms for health/status reads
    "loadTimeout": 900000,        // ms to wait for a load (Strata reads 35-55 GB: 1-3 min)
    "reasoningBudgets": {}        // e.g. { "low": 1024, "medium": 4096, "high": 16384 }
  }
}
```

`reasoningBudgets` is off by default: Strata's `reasoning_effort` levels already
set the thinking length. When you set it, the matching value is sent as
`reasoning_budget_tokens` alongside the effort level.

`maxTokens` defaults to the smaller of the context window and 32768. Strata
shortens `max_tokens` itself when the prompt would not fit (`fit_max_tokens`),
so offering the whole window for one answer only invites runaways.

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
```

`test/live.mjs` is read-only unless `LOAD=1`, in which case it loads and
unloads the model once; `RELOAD=1` loads it again at the end (about 2 minutes
to give back and take 35 GB: measured at 10-20 s to unload and about 95 s to load
on a V100 with an IQ4_XS model).

`test/proxy.mjs` is a logging reverse proxy for checking the wire format
against a real server:

```bash
node test/proxy.mjs http://192.168.1.10:8081 8099 /tmp/proxy.log &
STRATA_SERVER_URL=http://127.0.0.1:8099 pi -e ./src/index.ts --thinking high \
  --model 'strata-server=http://127.0.0.1:8099/<model>' "hi"
```
