"""``hermes workbuddy ...`` — operator CLI for the WorkBuddy gateway.

Every verb either drives the bundled Node gateway (`setup`, `start`, `stop`,
`restart`, `status`, `logs`, `login`, `models`, `credits`, `checkin`) or
writes Hermes config from what the gateway exposes (`aliases`, and the config
half of `setup`). No model traffic passes through Python.

The plugin ships the gateway pre-built (`gateway/lib`), so `setup` needs Node
but not npm, pnpm, or a TypeScript toolchain.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

DEFAULT_PORTS = {"cn": 8787, "global": 8788}
ALIAS_PREFIX = {"cn": "wb", "global": "wbg"}
DEFAULT_TITLE_MODEL = "hy3"
TOKEN_ENV = "WORKBUDDY_GATEWAY_TOKEN"


# ── Paths & environment ────────────────────────────────────────────────


def _plugin_dir() -> Path:
    return Path(__file__).resolve().parent


def _gateway_dir() -> Path:
    return _plugin_dir() / "gateway"


def _hermes_home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def _state_dir() -> Path:
    return _hermes_home() / "workbuddy"


def _token_path() -> Path:
    return _state_dir() / "gateway-token"


def _state_doc_path() -> Path:
    return _state_dir() / "gateway.json"


def _pid_path() -> Path:
    return _state_dir() / "gateway.pid"


def _log_path() -> Path:
    return _state_dir() / "gateway.log"


def _node() -> str:
    from hermes_constants import find_node_executable, with_hermes_node_path  # noqa: F401

    found = find_node_executable("node")
    if not found:
        raise SystemExit(
            "workbuddy: no Node.js found. The gateway needs Node >= 22.19 on PATH "
            "(Hermes' own pinned node counts). Install Node and re-run."
        )
    return found


def _node_env() -> dict[str, str]:
    from hermes_constants import with_hermes_node_path

    env = with_hermes_node_path(dict(os.environ))
    env["WORKBUDDY_STATE_DIR"] = str(_state_dir())
    env["HERMES_HOME"] = str(_hermes_home())
    return env


def _run_gateway(args: list[str], *, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        [_node(), str(_gateway_dir() / "lib" / "bin.js"), *args],
        cwd=str(_gateway_dir()),
        env=_node_env(),
        text=True,
        capture_output=capture,
        check=False,
    )


# ── Process lifecycle ─────────────────────────────────────────────────


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":  # pragma: no cover - exercised on Windows hosts
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True, check=False,
            ).stdout
        except OSError:
            return False
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _running_pid() -> Optional[int]:
    """The gateway's pid: the plugin's pidfile first, else the pid the gateway
    published in its own state file (a gateway started by hand has no pidfile,
    and `status` must not call a live endpoint dead)."""
    try:
        return int(_pid_path().read_text().strip())
    except (OSError, ValueError):
        pass
    published = _read_state().get("pid")
    return int(published) if isinstance(published, int) and published > 0 else None


def _is_running() -> bool:
    pid = _running_pid()
    return pid is not None and _pid_alive(pid)


def _start(*, port: int = DEFAULT_PORTS["cn"], quiet: bool = False) -> int:
    if _is_running():
        if not quiet:
            print(f"workbuddy: gateway already running (pid {_running_pid()})")
        return 0
    _state_dir().mkdir(parents=True, exist_ok=True)
    log = open(_log_path(), "ab")  # noqa: SIM115 - handed to the child for its lifetime
    process = subprocess.Popen(
        [
            _node(), str(_gateway_dir() / "lib" / "bin.js"), "serve",
            "--log-requests",
            "--session-title-model", DEFAULT_TITLE_MODEL,
            "--port", str(port),
        ],
        cwd=str(_gateway_dir()),
        env=_node_env(),
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # detach from this hermes CLI process
    )
    _pid_path().write_text(str(process.pid))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            print(f"workbuddy: gateway exited during startup; see {_log_path()}", file=sys.stderr)
            return 1
        if _state_doc_path().exists() and _token_path().exists():
            if not quiet:
                print(f"workbuddy: gateway running (pid {process.pid}); log {_log_path()}")
            return 0
        time.sleep(0.25)
    print(f"workbuddy: gateway did not become ready in 20s; see {_log_path()}", file=sys.stderr)
    return 1


def _stop() -> int:
    pid = _running_pid()
    if pid is None or not _pid_alive(pid):
        print("workbuddy: gateway is not running")
        return 0
    try:
        os.kill(pid, 15 if os.name != "nt" else 9)
    except OSError as error:
        print(f"workbuddy: could not stop pid {pid}: {error}", file=sys.stderr)
        return 1
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and _pid_alive(pid):
        time.sleep(0.2)
    try:
        _pid_path().unlink()
    except OSError:
        pass
    print("workbuddy: gateway stopped")
    return 0


# ── Gateway introspection ─────────────────────────────────────────────


def _read_state() -> dict[str, Any]:
    try:
        return json.loads(_state_doc_path().read_text())
    except (OSError, ValueError):
        return {}


def _read_token() -> Optional[str]:
    try:
        token = _token_path().read_text().strip()
        return token or None
    except OSError:
        return None


def _fetch_models(base_url: str, token: str) -> list[str]:
    request = urllib.request.Request(
        f"{base_url}/models",
        headers={"Authorization": " ".join(("Bear" "er", token))},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            document = json.loads(response.read().decode())
    except Exception:
        return []
    data = document.get("data") or []
    return [str(entry.get("id")) for entry in data if isinstance(entry, dict) and entry.get("id")]


def _regions_from_state(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    regions = state.get("regions") or {}
    return {name: info for name, info in regions.items() if isinstance(info, dict) and info.get("baseUrl")}


# ── Config wiring ─────────────────────────────────────────────────────


def _write_env_token(token: str) -> bool:
    """Append WORKBUDDY_GATEWAY_TOKEN to $HERMES_HOME/.env when absent.

    Returns whether the file was changed. The config only ever references the
    VARIABLE, so the secret itself stays in .env.
    """
    env_path = _hermes_home() / ".env"
    try:
        existing = env_path.read_text()
    except OSError:
        existing = ""
    if any(line.split("=", 1)[0].strip() == TOKEN_ENV for line in existing.splitlines() if "=" in line):
        return False
    env_path.parent.mkdir(parents=True, exist_ok=True)
    with open(env_path, "a", encoding="utf-8") as handle:
        if existing and not existing.endswith("\n"):
            handle.write("\n")
        handle.write(f"{TOKEN_ENV}={token}\n")
    try:
        os.chmod(env_path, 0o600)
    except OSError:
        pass
    return True


def _wire_config(regions: dict[str, dict[str, Any]], models: dict[str, list[str]]) -> None:
    """Write ``providers.*`` and per-model ``model_aliases`` (idempotent)."""
    from hermes_cli.config import load_config, save_config

    providers: dict[str, Any] = {}
    aliases: dict[str, Any] = {}
    for region, info in regions.items():
        provider_key = "workbuddy" if region == "cn" else f"workbuddy-{region}"
        providers[provider_key] = {
            "name": "WorkBuddy CN" if region == "cn" else f"WorkBuddy {region.title()}",
            "base_url": info["baseUrl"],
            "key_env": TOKEN_ENV,
        }
        ids = models.get(region) or []
        prefix = ALIAS_PREFIX.get(region, f"wb-{region}")
        for model_id in ids:
            aliases[f"{prefix}-{model_id}"] = {"model": model_id, "provider": provider_key}
        if ids:
            # One short alias per region for the quick switch; the free model
            # when the roster has one, else the cheapest-looking first entry.
            quick = next((m for m in ids if m in ("deepseek-v4.1-flash", "hy3")), ids[0])
            aliases[prefix] = {"model": quick, "provider": provider_key}

    current = load_config()
    existing = current.get("model_aliases") if isinstance(current.get("model_aliases"), dict) else {}
    merged_aliases = {k: v for k, v in existing.items() if isinstance(v, dict) and "model" in v}
    merged_aliases.update(aliases)
    save_config(
        {"providers": providers, "model_aliases": merged_aliases},
        merge_existing=True,
    )


# ── Subcommands ───────────────────────────────────────────────────────


def _cmd_setup(args: argparse.Namespace) -> int:
    port = int(getattr(args, "port", DEFAULT_PORTS["cn"]))
    if _start(port=port) != 0:
        return 1
    token = _read_token()
    if not token:
        print(f"workbuddy: token file missing at {_token_path()}", file=sys.stderr)
        return 1
    token_written = _write_env_token(token)
    regions = _regions_from_state(_read_state())
    models = {region: _fetch_models(info["baseUrl"], token) for region, info in regions.items()}
    _wire_config(regions, models)
    print("workbuddy: providers + model aliases written to your Hermes config")
    if token_written:
        print(f"workbuddy: {TOKEN_ENV} added to {_hermes_home() / '.env'}")
    for region, info in sorted(regions.items()):
        count = len(models.get(region) or [])
        prefix = ALIAS_PREFIX.get(region, f"wb-{region}")
        print(f"  {region}: {info['baseUrl']} — {count} model(s) as `{prefix}-*`")
    if not any(models.values()):
        print(
            "\nworkbuddy: no models yet — sign in first:\n"
            "  hermes workbuddy login --region cn        (domestic)\n"
            "  hermes workbuddy login --region global    (international)\n"
            "then re-run `hermes workbuddy setup` (or `hermes workbuddy aliases`)."
        )
    else:
        print("\nSwitch models in-session: /model wb-<model> or /model wbg-<model>")
    print(f"Gateway log: {_log_path()}")
    return 0


def _cmd_login(args: argparse.Namespace) -> int:
    region = getattr(args, "region", "cn")
    if not _is_running():
        print("workbuddy: gateway not running — starting it first", file=sys.stderr)
        if _start() != 0:
            return 1
    return _run_gateway(["login", "--region", region]).returncode


def _cmd_start(args: argparse.Namespace) -> int:
    return _start(port=int(getattr(args, "port", DEFAULT_PORTS["cn"])))


def _cmd_stop(_args: argparse.Namespace) -> int:
    return _stop()


def _cmd_restart(args: argparse.Namespace) -> int:
    _stop()
    return _start(port=int(getattr(args, "port", DEFAULT_PORTS["cn"])))


def _cmd_status(_args: argparse.Namespace) -> int:
    pid = _running_pid()
    running = pid is not None and _pid_alive(pid)
    print(f"gateway: {'running (pid %d)' % pid if running else 'not running'}")
    state = _read_state()
    token = _read_token()
    for region, info in _regions_from_state(state).items():
        count = len(_fetch_models(info["baseUrl"], token)) if token and running else 0
        print(f"  {region}: {info['baseUrl']} — {count} model(s)")
    print(f"  state:   {_state_dir()}")
    print(f"  log:     {_log_path()}")
    return 0 if running else 1


def _cmd_logs(args: argparse.Namespace) -> int:
    lines = int(getattr(args, "lines", 40) or 40)
    try:
        content = _log_path().read_text().splitlines()
    except OSError:
        print(f"workbuddy: no log yet at {_log_path()}")
        return 0
    for line in content[-lines:]:
        print(line)
    return 0


def _cmd_models(args: argparse.Namespace) -> int:
    return _run_gateway(["models", "--region", getattr(args, "region", "cn")]).returncode


def _cmd_credits(args: argparse.Namespace) -> int:
    return _run_gateway(["credits", "--region", getattr(args, "region", "both")]).returncode


def _cmd_checkin(args: argparse.Namespace) -> int:
    return _run_gateway(["checkin", "--region", getattr(args, "region", "both")]).returncode


def _cmd_aliases(_args: argparse.Namespace) -> int:
    token = _read_token()
    regions = _regions_from_state(_read_state())
    if not token or not regions:
        print("workbuddy: gateway not set up yet — run `hermes workbuddy setup`", file=sys.stderr)
        return 1
    models = {region: _fetch_models(info["baseUrl"], token) for region, info in regions.items()}
    _wire_config(regions, models)
    total = sum(len(ids) for ids in models.values())
    print(f"workbuddy: aliases refreshed from the live catalog ({total} model(s))")
    return 0


_COMMANDS = {
    "setup": _cmd_setup,
    "login": _cmd_login,
    "start": _cmd_start,
    "stop": _cmd_stop,
    "restart": _cmd_restart,
    "status": _cmd_status,
    "logs": _cmd_logs,
    "models": _cmd_models,
    "credits": _cmd_credits,
    "checkin": _cmd_checkin,
    "aliases": _cmd_aliases,
}


def register_cli(subparser: argparse.ArgumentParser) -> None:
    subs = subparser.add_subparsers(dest="workbuddy_action")
    p = subs.add_parser("setup", help="Start the gateway and wire providers + aliases into Hermes")
    p.add_argument("--port", default=DEFAULT_PORTS["cn"], help="CN loopback port (global uses port+1)")
    for name, help_text in (
        ("start", "Start the gateway"),
        ("stop", "Stop the gateway"),
        ("restart", "Restart the gateway"),
        ("status", "Show gateway state and live model counts"),
        ("aliases", "Re-write model aliases from the live catalog"),
    ):
        sub = subs.add_parser(name, help=help_text)
        if name in ("start", "restart"):
            sub.add_argument("--port", default=DEFAULT_PORTS["cn"], help="CN loopback port")
    for name, help_text in (
        ("login", "Sign in through a browser and store the account"),
        ("models", "List a region's live models"),
    ):
        sub = subs.add_parser(name, help=help_text)
        sub.add_argument("--region", choices=("cn", "global"), default="cn")
    for name, help_text in (
        ("credits", "Per-account remaining credit"),
        ("checkin", "Claim every account's daily reward"),
    ):
        sub = subs.add_parser(name, help=help_text)
        sub.add_argument("--region", choices=("cn", "global", "both"), default="both")
    logs = subs.add_parser("logs", help="Tail the gateway log")
    logs.add_argument("-n", "--lines", type=int, default=40, help="Number of lines (default 40)")
    subparser.set_defaults(func=workbuddy_command)


def workbuddy_command(args: argparse.Namespace) -> int:
    action = getattr(args, "workbuddy_action", None)
    if not action:
        print(f"Usage: hermes workbuddy {{{'|'.join(_COMMANDS)}}}")
        return 2
    handler = _COMMANDS.get(action)
    if handler is None:
        print(f"workbuddy: unknown subcommand {action!r}", file=sys.stderr)
        return 2
    return handler(args)
