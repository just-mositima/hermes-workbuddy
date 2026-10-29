# WorkBuddy Models for Hermes Agent

A Hermes Agent plugin that turns models from a **WorkBuddy desktop sign-in** (domestic `codebuddy.cn` / international `workbuddy.ai`) into OpenAI-compatible endpoints Hermes can use as named providers — with browser sign-in, per-model aliases, account failover, credits and daily check-in.

```bash
hermes plugins install OWNER/hermes-workbuddy     # install the plugin
hermes workbuddy setup                            # start the gateway + write providers/aliases
hermes workbuddy login --region cn                # authorize in a browser (no desktop app needed)
hermes workbuddy setup                            # re-run once signed in: aliases from the live catalog
```

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
hermes workbuddy setup [--port 8787]   # start gateway + write providers, aliases, .env token
hermes workbuddy login --region cn|global
hermes workbuddy status                # gateway state + live model counts
hermes workbuddy models --region cn|global
hermes workbuddy credits [--region …]  # per-account remaining credit
hermes workbuddy checkin [--region …]  # claim daily rewards
hermes workbuddy aliases               # re-write aliases from the live catalog
hermes workbuddy start|stop|restart|logs
```

`setup` writes, idempotently:

- `providers.workbuddy` and `providers.workbuddy-global` (base URL + `key_env: WORKBUDDY_GATEWAY_TOKEN`)
- `model_aliases.wb-<model>` / `model_aliases.wbg-<model>`, plus one short alias per region (`wb`, `wbg`)
- `WORKBUDDY_GATEWAY_TOKEN` in `~/.hermes/.env` when absent

The gateway runs with `--log-requests` (one JSONL line per upstream attempt in `~/.hermes/workbuddy/requests.<region>.jsonl`) and `--session-title-model hy3`, which re-points Hermes' per-session title requests at a free model — otherwise each conversation shows one extra tiny billed request on the provider's usage page.

## Requirements

- Hermes Agent ≥ 0.22
- Node.js ≥ 22.19 on the machine (Hermes' own pinned node counts) — the gateway is Node
- A WorkBuddy account: either sign in through the plugin's browser flow, or have the WorkBuddy desktop app signed in on the same machine (its auth file is read, never modified)

## Switching accounts and regions

Both regions run side by side. `wb-*` aliases are domestic, `wbg-*` are international; each region keeps its own credentials, catalog and account pool. With several signed-in accounts per region the gateway fails over and benches an account for the cooldown the upstream itself states.

## Uninstall

```bash
hermes workbuddy stop
hermes plugins remove workbuddy
# Optional: delete the gateway's state directory (it lives at
# $HERMES_HOME/workbuddy) and remove the providers.* / model_aliases.wb* / wbg*
# entries from config.yaml if you want the aliases gone too.
```

## Development

```bash
cd gateway && pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run build   # rebuild lib/ before committing source changes
```

CI validates the plugin manifest, compiles the Python modules, and runs the gateway's typecheck + full test suite on Linux and Windows (plus the pi-ai 1.x leg).

## License

MIT — see [LICENSE](LICENSE). Upstream attribution and third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
