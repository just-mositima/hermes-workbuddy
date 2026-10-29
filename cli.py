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
import contextlib
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

DEFAULT_PORTS = {"cn": 8787, "global": 8788}
ALIAS_PREFIX = {"cn": "wb", "global": "wbg"}
DEFAULT_TITLE_MODEL = "hy3"
TOKEN_ENV = "WORKBUDDY_GATEWAY_TOKEN"
# Autostart: keep the loopback gateway alive alongside Hermes so a session that
# selects a wb-* / wbg-* model never meets a dead endpoint. `WORKBUDDY_AUTOSTART=0`
# (env) or `hermes workbuddy autostart off` (persisted marker) disables it;
# `hermes workbuddy stop` parks it until an explicit `start`.
AUTOSTART_ENV = "WORKBUDDY_AUTOSTART"
AUTOSTART_MARKER = "autostart"
AUTOSTART_HOOK_NAME = "workbuddy-autostart"
STOP_MARKER = "stopped"
WATCHDOG_SECONDS = 30.0
WORKBUDDY_PROVIDER_PREFIX = "workbuddy"

logger = logging.getLogger("hermes.plugins.workbuddy")


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


def _hook_target_dir() -> Path:
    return _hermes_home() / "hooks" / AUTOSTART_HOOK_NAME


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


def _flag_path(name: str) -> Path:
    return _state_dir() / name


def _read_flag(name: str) -> Optional[str]:
    try:
        value = _flag_path(name).read_text().strip().lower()
    except OSError:
        return None
    return value or None


def _write_flag(name: str, value: Optional[str]) -> None:
    path = _flag_path(name)
    try:
        if value is None:
            path.unlink()
            return
        _state_dir().mkdir(parents=True, exist_ok=True)
        path.write_text(f"{value}\n")
    except OSError:
        pass


def _port_open(port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _region_ports(state: Optional[dict[str, Any]] = None) -> list[int]:
    ports: list[int] = []
    for info in _regions_from_state(state if state is not None else _read_state()).values():
        match = re.search(r":(\d+)(?:/|$)", str(info.get("baseUrl") or ""))
        if match:
            ports.append(int(match.group(1)))
    if not ports:
        ports.extend((DEFAULT_PORTS["cn"], DEFAULT_PORTS["global"]))
    return ports


def _serving() -> bool:
    return any(_port_open(port) for port in _region_ports())


def _is_running() -> bool:
    """The gateway is up: its pid is alive AND a region port answers.

    A stale pidfile (pid reused after a container restart, or a crash the pid
    outlived) must not read as "running" — that is exactly the state where every
    wb-* request refuses connections while ``status`` still looks healthy.
    """
    pid = _running_pid()
    if pid is None or not _pid_alive(pid):
        return False
    if _serving():
        return True
    # Alive but not accepting yet: a gateway that is still booting, or a pid that
    # belongs to something else. Wait one short window, then decide.
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return False
        time.sleep(0.2)
        if _serving():
            return True
    return False


@contextlib.contextmanager
def _start_lock():
    """Serialise starts across processes (TUI, gateway, one-shot CLI, hooks)."""
    _state_dir().mkdir(parents=True, exist_ok=True)
    handle = None
    try:
        handle = open(_flag_path("gateway.lock"), "a+")  # noqa: SIM115 - released in finally
        try:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):  # Windows: best effort; the pidfile still gates
            pass
        yield
    finally:
        if handle is not None:
            try:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
            handle.close()


def autostart_enabled() -> bool:
    env = os.environ.get(AUTOSTART_ENV, "").strip().lower()
    if env in ("0", "false", "no", "off", "disabled"):
        return False
    if env in ("1", "true", "yes", "on"):
        return True
    return _read_flag(AUTOSTART_MARKER) != "off"


def _stopped_by_operator() -> bool:
    return _read_flag(STOP_MARKER) == "stop"


def _ensure_running(*, quiet: bool = True, respect_stop: bool = True, port: Optional[int] = None) -> bool:
    """Idempotent, cross-process-safe "the gateway must be up" primitive."""
    if respect_stop and _stopped_by_operator():
        return False
    if _is_running():
        return True
    with _start_lock():
        if _is_running():
            return True
        if respect_stop and _stopped_by_operator():
            return False
        return _start(port=port or DEFAULT_PORTS["cn"], quiet=quiet) == 0


def _start(*, port: int = DEFAULT_PORTS["cn"], quiet: bool = False) -> int:
    _write_flag(STOP_MARKER, None)  # an explicit start overrides `stop`
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
        # The state doc is written before the ports bind, so "ready" must mean
        # "a region port actually accepts a connection" — otherwise the first
        # wb-* request races the listener and fails with ECONNREFUSED.
        if _state_doc_path().exists() and _token_path().exists() and _serving():
            if not quiet:
                print(f"workbuddy: gateway running (pid {process.pid}); log {_log_path()}")
            return 0
        time.sleep(0.25)
    print(f"workbuddy: gateway did not become ready in 20s; see {_log_path()}", file=sys.stderr)
    return 1


def _stop() -> int:
    _write_flag(STOP_MARKER, "stop")  # park autostart/ watchdog until an explicit start
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


# ── Autostart: hooks + watchdog ───────────────────────────────────────
#
# The gateway is a separate Node process, so nothing keeps it alive across a
# container restart or a crash. These hooks hand that job to Hermes itself:
#   * on_session_start   — a session begins: start the gateway off-thread
#   * pre_api_request    — a wb-*/*wbg-* call is about to fly: start it inline
#   * pre_auxiliary_call — same for titling/vision/compression calls
# plus a 30s watchdog thread that restarts a dead gateway in any process where
# the plugin is loaded. All of it is idempotent (pidfile + flock) and stays out
# of the way of an explicit `hermes workbuddy stop`.

_AUTOSTART_THREAD: Optional[threading.Thread] = None
_WATCHDOG_THREAD: Optional[threading.Thread] = None


def _is_workbuddy_provider(provider: Any) -> bool:
    name = str(provider or "").strip().lower()
    return name == WORKBUDDY_PROVIDER_PREFIX or name.startswith(f"{WORKBUDDY_PROVIDER_PREFIX}-")


def _autostart_sync(reason: str = "", provider: Any = None) -> None:
    if provider is not None and not _is_workbuddy_provider(provider):
        return
    try:
        if not autostart_enabled():
            return
        if _ensure_running():
            return
        logger.debug("workbuddy autostart (%s): gateway not started", reason)
    except Exception:  # a hook must never break the caller's turn
        logger.warning("workbuddy autostart (%s) failed", reason, exc_info=True)


def _autostart_async(reason: str = "") -> None:
    global _AUTOSTART_THREAD
    if not autostart_enabled():
        return
    if _AUTOSTART_THREAD is not None and _AUTOSTART_THREAD.is_alive():
        return
    _AUTOSTART_THREAD = threading.Thread(
        target=_autostart_sync, kwargs={"reason": reason}, name="workbuddy-autostart", daemon=True,
    )
    _AUTOSTART_THREAD.start()


def on_session_start(**_kwargs: Any) -> None:
    """Hook: a session is starting — bring the gateway up off the critical path."""
    _autostart_async("session_start")


def on_pre_api_request(*, provider: Any = None, **_kwargs: Any) -> None:
    """Hook: a model call is about to fly — guarantee the endpoint when it is ours."""
    if not _is_workbuddy_provider(provider):
        return
    _autostart_sync("pre_api_request", provider=provider)


def _watchdog_loop() -> None:
    while True:
        time.sleep(WATCHDOG_SECONDS)
        try:
            if not autostart_enabled() or _stopped_by_operator():
                continue
            if not _is_running():
                _ensure_running(quiet=True)
        except Exception:
            logger.warning("workbuddy watchdog tick failed", exc_info=True)


def _start_watchdog() -> None:
    global _WATCHDOG_THREAD
    if _WATCHDOG_THREAD is not None and _WATCHDOG_THREAD.is_alive():
        return
    _WATCHDOG_THREAD = threading.Thread(target=_watchdog_loop, name="workbuddy-watchdog", daemon=True)
    _WATCHDOG_THREAD.start()


def install_lifecycle_hook() -> str:
    """Copy the bundled gateway hook into ``$HERMES_HOME/hooks/`` (idempotent)."""
    source = _plugin_dir() / "autostart_hook"
    missing = [n for n in ("HOOK.yaml", "handler.py") if not (source / n).is_file()]
    if missing:
        raise FileNotFoundError(f"bundled gateway hook is missing {missing} under {source}")
    target = _hook_target_dir()
    target.mkdir(parents=True, exist_ok=True)
    for name in ("HOOK.yaml", "handler.py"):
        shutil.copy2(source / name, target / name)
    return str(target)


def lifecycle_hook_installed() -> bool:
    target = _hook_target_dir()
    return (target / "HOOK.yaml").is_file() and (target / "handler.py").is_file()


def install_autostart(ctx: Any) -> None:
    """Wire the plugin into Hermes' lifecycle (called from ``register``).

    ``hermes workbuddy ...`` invocations opt out: ``stop`` must stay stopped, and
    a short-lived CLI process gains nothing from a watchdog.
    """
    if sys.argv[1:2] == ["workbuddy"]:
        return
    for hook_name, callback in (
        ("on_session_start", on_session_start),
        ("pre_api_request", on_pre_api_request),
        ("pre_auxiliary_call", on_pre_api_request),
    ):
        try:
            ctx.register_hook(hook_name, callback)
        except Exception:
            logger.warning("workbuddy: could not register %s hook", hook_name, exc_info=True)
    _start_watchdog()


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
    if not _ensure_running(quiet=True, port=port):
        print(f"workbuddy: gateway could not start; see {_log_path()}", file=sys.stderr)
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
    try:
        print(f"workbuddy: gateway hook installed at {install_lifecycle_hook()}")
    except OSError as error:
        print(f"workbuddy: could not install the gateway hook: {error}", file=sys.stderr)
    print("workbuddy: autostart on — the gateway comes up with Hermes (disable: hermes workbuddy autostart off)")
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
    port = int(getattr(args, "port", DEFAULT_PORTS["cn"]))
    if _is_running():
        print(f"workbuddy: gateway already running (pid {_running_pid()})")
        return 0
    if _ensure_running(quiet=False, port=port):
        return 0
    print(f"workbuddy: gateway could not start; see {_log_path()}", file=sys.stderr)
    return 1


def _cmd_stop(_args: argparse.Namespace) -> int:
    return _stop()


def _cmd_restart(args: argparse.Namespace) -> int:
    port = int(getattr(args, "port", DEFAULT_PORTS["cn"]))
    _stop()
    return _cmd_start(argparse.Namespace(port=port))


def _cmd_status(_args: argparse.Namespace) -> int:
    pid = _running_pid()
    running = _is_running()
    print(f"gateway: {'running (pid %d)' % pid if running else 'not running'}")
    state = _read_state()
    token = _read_token()
    autostart = "on" if autostart_enabled() else "off"
    parked = " (parked by `stop` — run `start`)" if _stopped_by_operator() else ""
    print(f"  autostart: {autostart}{parked}")
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


def _cmd_autostart(args: argparse.Namespace) -> int:
    mode = getattr(args, "mode", None) or "status"
    if mode in ("on", "off"):
        _write_flag(AUTOSTART_MARKER, mode)
        print(f"workbuddy: autostart {mode}")
        if mode == "on":
            try:
                print(f"workbuddy: gateway hook installed at {install_lifecycle_hook()}")
            except OSError as error:
                print(f"workbuddy: could not install the gateway hook: {error}", file=sys.stderr)
            return _cmd_start(argparse.Namespace(port=DEFAULT_PORTS["cn"]))
        return 0
    enabled = autostart_enabled()
    source = "env " + AUTOSTART_ENV if os.environ.get(AUTOSTART_ENV) else f"marker {_flag_path(AUTOSTART_MARKER)}"
    print(f"autostart: {'on' if enabled else 'off'} ({source})")
    print(f"gateway:   {'running' if _is_running() else 'not running'}")
    hook = "installed" if lifecycle_hook_installed() else "not installed"
    print(f"hook:      {hook} ({_hook_target_dir()})")
    return 0


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
    "autostart": _cmd_autostart,
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
    autostart = subs.add_parser(
        "autostart",
        help="Keep the gateway running with Hermes (on|off|status, default status)",
    )
    autostart.add_argument("mode", nargs="?", choices=("on", "off", "status"), default="status")
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
