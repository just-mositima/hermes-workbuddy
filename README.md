# WorkBuddy Models for Hermes Agent

A Hermes Agent plugin that turns models from a **WorkBuddy desktop sign-in** (domestic `codebuddy.cn` / international `workbuddy.ai`) into OpenAI-compatible endpoints Hermes can use as named providers — with browser sign-in, per-model aliases, account failover, credits and daily check-in.

```bash
# 1 · install the plugin — paste this repo URL into the Hermes plugin manager
#     (desktop app / dashboard), or run it directly:
hermes plugins install https://github.com/just-mositima/hermes-workbuddy
# 2 · start the gateway + write provider entries, aliases and the boot hook
hermes workbuddy install
# 3 · sign in through a browser (no desktop app needed)
hermes workbuddy login --region cn
# 4 · once signed in, refresh the model aliases from the live catalog
hermes workbuddy setup
```

`just-mositima/hermes-workbuddy` (the `owner/repo` shorthand) and the full
`https://github.com/...` URL are the same install; pick whichever the surface
you are on accepts. Everything the installer needs is committed — `gateway/lib`
is pre-built, so `hermes plugins install` runs no `npm`/`pnpm`/`tsc` step and
the clone itself is the whole download.

Then switch like any model — in a session: `/model wb-hy3`, or from the CLI: `hermes -m wbg-gpt-5.6-luna chat -q "..."`.

## What it actually is

Two halves, packaged together:

| Half | Language | Where |
|---|---|---|
| Hermes plugin: manifest + `hermes workbuddy …` operator CLI | Python | `plugin.yaml`, `__init__.py`, `cli.py` |
| Gateway: loopback OpenAI-compatible endpoint, WorkBuddy auth/refresh, model catalog, account pool, credits | Node (pre-built) | `gateway/` — full source and tests; `gateway/lib` is committed so installation needs no build step |

The gateway started by `setup` listens on `127.0.0.1` only (ports **8787** CN and **8788** global by default), with a bearer minted once into `~/.hermes/workbuddy/` and referenced from `~/.hermes/.env` as `WORKBUDDY_GATEWAY_TOKEN`. It never forwards the bearer upstream; requests carry the WorkBuddy access token, refreshed on demand.

The core came from [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) (MIT, Copyright (c) 2026 LaoDing) — the WorkBuddy protocol client, credential store, loopback shim, DSML tool-call recovery and account pool are that project's, adapted into a host-independent gateway. See [gateway/README.md](gateway/README.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Commands

```
hermes workbuddy install [--port 8787] # one command: gateway + providers + aliases + .env + boot hook
hermes workbuddy setup   [--port 8787] # same wiring (kept for scripts that already call it)
hermes workbuddy login --region cn|global
hermes workbuddy account [--region cn|global] [<index>|<id>|<name>|--clear]
hermes workbuddy status                # gateway state + autostart + live model counts
hermes workbuddy models --region cn|global
hermes workbuddy credits [--region …]  # per-account remaining credit
hermes workbuddy checkin [--region …] [--auto on|off|status]  # claim daily rewards
hermes workbuddy checkin --travel [--location N]             # claim + run the 派猫猫 loop
hermes workbuddy travel [--region …] [--status] [--location 1-4] [--auto on|off|status]
hermes workbuddy notify [status|test]                        # push channels for the runs above
hermes workbuddy aliases               # re-write aliases from the live catalog
hermes workbuddy autostart [on|off]    # keep the gateway alive with Hermes (default: status)
hermes workbuddy start|stop|restart|logs
```

Inside a conversation, the same operations are `/workbuddy …` — see
[In-session channel](#in-session-channel-workbuddy).

`setup` writes, idempotently:

- `providers.workbuddy` and `providers.workbuddy-global` (base URL + `key_env: WORKBUDDY_GATEWAY_TOKEN`)
- `model_aliases.wb-<model>` / `model_aliases.wbg-<model>`, plus one short alias per region (`wb`, `wbg`)
- `WORKBUDDY_GATEWAY_TOKEN` in `~/.hermes/.env` when absent

The gateway runs with `--log-requests` (one JSONL line per upstream attempt in `~/.hermes/workbuddy/requests.<region>.jsonl`) and `--session-title-model hy3`, which re-points Hermes' per-session title requests at a free model — otherwise each conversation shows one extra tiny billed request on the provider's usage page.

## Autostart: the gateway lives and dies with Hermes

The gateway is a separate Node process, so a container restart (or a crash) used to leave `wb-*` requests hitting a dead `127.0.0.1:8787`. Three layers prevent that, all driven by Hermes itself — no compose changes, no extra sidecar:

| Layer | Where | What it does |
|---|---|---|
| Plugin hooks | `cli.py`, registered at plugin load | Starts the gateway when a session starts, and again inline before any `workbuddy*` API call — the request waits for a *listening* port, not just a state file. A 30 s watchdog thread restarts it after a crash. |
| Boot hook | `$HERMES_HOME/hooks/workbuddy-autostart/` | Fires on Hermes' `gateway:startup` (and on `session:start`), so a restarting container has the endpoint up before the first message arrives. |
| Self-assembly | `register()` in `__init__.py` | Whatever process loads the plugin recreates the boot hook if it is missing (a fresh volume, a profile copied without `hooks/`). Installing the plugin is therefore the only manual step — no follow-up `setup` needed to make a second deployment boot-ready. |

### Which deployments get the gateway, and how

Nothing here is deployment-specific: every row is the plugin doing the same
thing at a different entry point, so the same install works for a laptop CLI, a
long-running gateway, the desktop app, and a container.

| Hermes surface / deployment | What brings the gateway up |
|---|---|
| Interactive CLI, one-shot `hermes chat -q`, `/bg` sessions | `on_session_start` starts it off-thread; `pre_api_request` guarantees it before the first `wb-*` call; the watchdog keeps it up while the process lives |
| Ink TUI and the desktop app (both run the `tui_gateway` backend) | Same plugin hooks in the backend process; `/workbuddy` is the in-conversation panel |
| Messaging gateway (Telegram, Discord, Slack, …) | Boot hook on `gateway:startup`, before the first inbound message; `/workbuddy` renders its menu as platform buttons |
| Container stop/up, supervisor restart, new machine with the same volume | Boot hook fires on startup; self-assembly repairs the hook if the volume lost `hooks/` |
| cron jobs, dashboard actions, anything that only makes model calls | `pre_api_request` starts it inline for `workbuddy*` providers only |

In the official Hermes container these live under `HERMES_HOME` (`/opt/data`), i.e. on the mounted volume: the plugin, the hook, the sign-in vault and the config all survive `docker stop/up` — one command brings both up:

```bash
HERMES_UID=$(id -u) HERMES_GID=$(id -g) docker compose up -d
hermes workbuddy status      # gateway: running … + autostart: on + hook: installed
```

Checks and switches:

```bash
hermes workbuddy autostart        # on|off, whether the gateway runs, hook installed?
hermes workbuddy autostart off    # disable (the installed hook then no-ops)
WORKBUDDY_AUTOSTART=0 hermes …    # disable for one process only
hermes workbuddy stop             # parks autostart until an explicit `start`
tail -f $HERMES_HOME/workbuddy/autostart.log   # what the hook dispatched
```

The boot hook is read at Hermes startup: after installing it on a machine where Hermes is already running, restart the gateway once (`hermes gateway restart`) for that path to apply. The plugin hooks — and the in-session `/workbuddy` command — need no restart.

## Install note: the security scan

`hermes plugins install` runs a structural scan on community sources and asks for
confirmation (`caution` verdict) before installing — answer `y`, or pass
`--force` in scripts. The findings are honest but expected for this package: it
ships a pre-built Node app, so the scanner sees `inline_shell_exec` strings in
the bundled gateway (its probe code builds shell commands), the zero-width-space
channel-rescue feature (`invisible_unicode`), `~/.ssh` path checks in the
upstream's diagnostics, and loopback-URL literals in the gateway's test
fixtures. Everything it flags is in the vendored upstream code or its tests —
the plugin itself (`cli.py`) only runs `node gateway/lib/bin.js` and writes
Hermes config. Review the findings, not just the count:

```bash
hermes plugins install just-mositima/hermes-workbuddy --force
```

A catalog submission (reviewed once, then installable without the prompt) is the
natural next step if this becomes widely used.

## Requirements

- Hermes Agent ≥ 0.22
- Node.js ≥ 22.19 on the machine (Hermes' own pinned node counts) — the gateway is Node
- A WorkBuddy account: either sign in through the plugin's browser flow, or have the WorkBuddy desktop app signed in on the same machine (its auth file is read, never modified)

## In-session channel: `/workbuddy`

Changing an account used to mean leaving the conversation for a terminal (or
asking the model to shell out). The plugin registers an in-session slash
command instead, dispatched by Hermes itself — no model turn, no tool call:

```
/workbuddy                            status card + menu
/workbuddy status
/workbuddy checkin [cn|global]        claim today's reward on every account (一键签到)
/workbuddy checkin auto [on|off]      let the watchdog claim it once a day, no input
/workbuddy checkin travel [1-4]       claim, then run the 派猫猫 travel loop
/workbuddy travel [status] [1-4]      Buddy travel: claim a landed reward, then dispatch
/workbuddy travel auto [on|off]       let the watchdog run that loop once a day
/workbuddy notify [status|test]       push channels for check-in / travel runs
/workbuddy account [cn|global] [<index>|<id>|<name>|clear]
/workbuddy login [cn|global]          browser sign-in, URL printed in the conversation
/workbuddy aliases                    re-read the live catalog into Hermes aliases
/workbuddy models [cn|global]
/workbuddy credits
/workbuddy autostart [on|off]
/workbuddy start | stop | restart | logs
/workbuddy logout                     delete stored credentials (asks first)
```

Bare `/workbuddy` opens the menu, whose second item is **Daily check-in (签到)** —
one pick claims every account's reward. Check-in is idempotent upstream (the
gateway asks whether today was claimed and only writes when it was not), so
pressing it twice costs nothing and never double-claims. `checkin auto on` arms
the same claim once a day from the watchdog thread, logged to
`$HERMES_HOME/workbuddy/checkin.log`.

Account switching is one picker across both regions: it lists every stored
account as `CN (domestic) · 176****4084 [selected]` / `Global · just-mositima`,
plus a *follow the newest sign-in* row per region. For a keyboard-only switch,
`/workbuddy account 2` takes a 1-based index, an id prefix, or a name fragment.
Chinese verbs work too (`签到`, `账号`, `登录`, `状态`, `积分`).

The menu is rendered by the host's own clarify picker: the classic CLI / TUI /
desktop panel locally, buttons on Telegram, Discord and Slack. So the same
command works on every surface, and `login` behaves the same everywhere — it
starts the browser flow detached, prints the sign-in URL, and the account is
stored the moment the browser finishes, which is also why it works when the
gateway runs on another machine (the flow is a polled login, not a loopback
callback).

`hermes workbuddy account` is the terminal twin of `/workbuddy account`.

## Buddy travel (派猫猫) and push notifications

Merged from the SkillHub skill
[`totorosir-workbuddy-checkin`](https://skillhub.cn) (author totorosir), whose
documentation maps an activity the plugin did not cover — and whose other half
the plugin already had. What was merged, and what was deliberately skipped:

| Capability in the skill | Here |
|---|---|
| Buddy-Station daily check-in | **skipped — duplicate.** The gateway already claims it per account (`checkin`), with the advantage that its accounts come from `login`/the desktop file and its tokens are refreshed by the gateway itself, so no web-session authorization or refresh-token export is needed |
| 派猫猫 travel: status / claim / depart, closed loop | **merged** — native in the gateway (`travel`), so it shares the same credentials, account pool and refresh as the rest |
| "Claim first, then dispatch" ordering | **merged** (that ordering is the whole feature: an unclaimed landing blocks the next trip) |
| Three credential channels (local login state / web-session code / long-lived refresh token) | **skipped — duplicate.** These exist because a standalone script has no token store; the plugin is that token store. `hermes workbuddy login` + the gateway's refresh already cover "no desktop client, no re-authorization" |
| 12-channel push + desktop toast | **partially merged** — `notify` covers webhook / DingTalk / Feishu / WeCom / Slack / Telegram / Bark / email / a local JSONL log. Paid SMS and niche QQ/PushPlus channels are **skipped**: an unattended daily job must not be able to spend money, and those channels add a dependency surface for one destination each. A headless container has no toast, so the "system" channel is the JSONL log |
| Daily 09:00 automation via the client's own scheduler | **merged as** `travel auto on` / `checkin auto on` on the plugin's watchdog (runs while Hermes runs, no crontab, no client) |

```bash
hermes workbuddy travel --status          # 只读：状态 / 剩余奖励 / 到达倒计时
hermes workbuddy travel                   # claim an arrived reward, then dispatch again
hermes workbuddy travel --location 2      # 商场店铺 (1 咖啡馆 · 2 商场店铺 · 3 健身房 · 4 古镇客栈)
hermes workbuddy travel auto on           # run that loop once a day with the watchdog
hermes workbuddy checkin --travel         # claim the meter AND the trip in one run
```

Rows are per account per region, and the statuses are the *closed-loop* result,
not a raw upstream field: `claimed`, `departed` (`+ → dispatched` when both
happened), `traveling`, `limit`, `idle`, `skipped`, `failed`. Two upstream
behaviours worth knowing, both learned the hard way:

- `depart` **requires** `location_id` — an empty body answers `400 invalid
  request`, so "random" is a client-side pick among the four equal destinations.
- `403 no active buddy` means the account never activated 派猫猫. It is reported
  as `skipped`, not as a rejected credential, and the travel calls classify their
  own 403s for exactly that reason.

### Push notifications

```bash
hermes workbuddy notify            # channel readiness + the config path
hermes workbuddy notify test       # send one test message through every channel
```

`$HERMES_HOME/workbuddy/notify.json` (template written beside it as
`notify.json.example`) is the only place credentials for push live — never the
repo, never a skill directory:

```json
{
  "enabled": true,
  "success_notify": false,
  "channels": {
    "system": {},
    "dingtalk": {"webhook": "https://oapi.dingtalk.com/robot/send?access_token=…", "secret": "…"},
    "telegram": {"bot_token": "123:abc", "chat_id": "0"},
    "webhook": {"url": "https://example.com/hook", "payload_template": "{\"text\": \"{{content}}\"}"}
  }
}
```

Rules that hold in code: `enabled: false` (or no file) means silence;
success broadcasts need `success_notify: true`; failures always push when
enabled; channels are isolated (one 500 does not stop the others and never
changes the run's exit code); and nothing prints a URL, token or password — only
`channel=status`.

## Switching accounts and regions

Both regions run side by side. `wb-*` aliases are domestic, `wbg-*` are international; each region keeps its own credentials, catalog and account pool. With several signed-in accounts per region the gateway fails over and benches an account for the cooldown the upstream itself states. `/workbuddy account` picks the account that pays; `--clear` goes back to "newest sign-in".

## Uninstall

```bash
hermes workbuddy stop
hermes plugins remove workbuddy
# Optional: delete the gateway's state directory (it lives at
# $HERMES_HOME/workbuddy), drop the autostart hook directory
# ($HERMES_HOME/hooks/workbuddy-autostart — it no-ops without the plugin), and
# remove the providers.* / model_aliases.wb* / wbg* entries from config.yaml if
# you want the aliases gone too.
```

## Development

```bash
cd gateway && pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run build   # rebuild lib/ before committing source changes
```

CI validates the plugin manifest, compiles the Python modules, and runs the gateway's typecheck + full test suite on Linux and Windows (plus the pi-ai 1.x leg).

## License

MIT — see [LICENSE](LICENSE). Upstream attribution and third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
