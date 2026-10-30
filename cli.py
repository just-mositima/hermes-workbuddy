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
# One-click check-in: `/workbuddy checkin` claims it on demand; the optional
# daily mode lets the watchdog thread claim it once per day without any input
# (`hermes workbuddy checkin --auto on`, or `WORKBUDDY_CHECKIN_AUTO=1`).
CHECKIN_AUTO_MARKER = "checkin-auto"
CHECKIN_AUTO_ENV = "WORKBUDDY_CHECKIN_AUTO"
CHECKIN_STAMP = "checkin-stamp"
CHECKIN_LOG = "checkin.log"
# Buddy travel (派猫猫): the closed loop claims a landed reward, then dispatches.
# On demand via `travel`, and once a day from the watchdog when armed.
TRAVEL_AUTO_MARKER = "travel-auto"
TRAVEL_AUTO_ENV = "WORKBUDDY_TRAVEL_AUTO"
TRAVEL_STAMP = "travel-stamp"
TRAVEL_NEXT = "travel-next"
TRAVEL_LOG = "travel.log"

logger = logging.getLogger("hermes.plugins.workbuddy")

try:  # the plugin package's own modules; plain imports keep `import cli` working
    from . import notify as _notify
except ImportError:  # pragma: no cover - checkout/test import
    import notify as _notify  # type: ignore[no-redef]


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
            _auto_checkin_tick()
            _auto_travel_tick()
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


def ensure_lifecycle_hook() -> Optional[str]:
    """Install the boot hook when it is missing — the plugin's self-assembly step.

    Called from ``register``: whichever surface loads the plugin (interactive CLI,
    TUI, desktop backend, gateway, one-shot run) repairs the hook, so a deployment
    that only ever installed the plugin still gets the boot-time path. Never
    overwrites an existing hook (a user may have edited it) and never raises.
    """
    try:
        if lifecycle_hook_installed():
            return str(_hook_target_dir())
        return install_lifecycle_hook()
    except OSError:
        logger.debug("workbuddy: could not install the gateway boot hook", exc_info=True)
        return None


def install_autostart(ctx: Any) -> None:
    """Wire the plugin into Hermes' lifecycle (called from ``register``).

    ``hermes workbuddy ...`` invocations opt out: ``stop`` must stay stopped, and
    a short-lived CLI process gains nothing from a watchdog.
    """
    if sys.argv[1:2] == ["workbuddy"]:
        return
    ensure_lifecycle_hook()
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


def _gateway_capture(*argv: str, timeout: float = 30.0) -> tuple[int, str, str]:
    """Run one gateway verb and return ``(code, stdout, stderr)``."""
    try:
        result = subprocess.run(
            [_node(), str(_gateway_dir() / "lib" / "bin.js"), *argv],
            cwd=str(_gateway_dir()),
            env=_node_env(),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except SystemExit as stop:  # no Node.js on this host
        return 1, "", f"workbuddy: {stop.code or 'no Node.js found'}"
    except (OSError, subprocess.SubprocessError) as error:
        return 1, "", f"workbuddy: could not run the gateway: {error}"
    return result.returncode, result.stdout or "", result.stderr or ""


_ACCOUNT_LINE = re.compile(r"^\s*-\s+(?P<name>.*?)\s+\((?P<id>[^()]+)\)\s*(?P<rest>.*)$")


def _list_accounts(region: str) -> list[dict[str, Any]]:
    """The region's stored accounts, parsed from ``workbuddy account`` (no network)."""
    code, out, _err = _gateway_capture("account", "--region", region, timeout=15)
    if code != 0:
        return []
    accounts: list[dict[str, Any]] = []
    for line in out.splitlines():
        match = _ACCOUNT_LINE.match(line)
        if not match:
            continue
        rest = match.group("rest").strip()
        accounts.append(
            {
                "id": match.group("id").strip(),
                "name": match.group("name").strip(),
                "selected": "[selected]" in rest,
                "enterprise": "[enterprise]" in rest,
                "summary": rest,
            }
        )
    return accounts


def _region_label(region: str) -> str:
    return "cn (domestic)" if region == "cn" else region


def _status_text() -> str:
    """The card ``/workbuddy`` opens with: gateway, accounts, autostart, per-region counts."""
    running = _is_running()
    lines = [
        "WorkBuddy gateway: "
        + (f"running (pid {_running_pid()})" if running else "not running")
        + f" · autostart {'on' if autostart_enabled() else 'off'}"
        + f" · boot hook {'installed' if lifecycle_hook_installed() else 'missing'}"
    ]
    if _stopped_by_operator():
        lines.append("  parked by `hermes workbuddy stop` — `/workbuddy start` brings it back")
    token = _read_token()
    regions = _regions_from_state(_read_state())
    if not regions:
        lines.append("  not configured yet — run `hermes workbuddy install`")
        return "\n".join(lines)
    for region in sorted(regions):
        info = regions[region]
        prefix = ALIAS_PREFIX.get(region, f"wb-{region}")
        models = len(_fetch_models(info["baseUrl"], token)) if running and token else 0
        accounts = _list_accounts(region)
        if accounts:
            selected = next((a for a in accounts if a["selected"]), None)
            billing = selected["name"] if selected else "newest sign-in"
            who = f"{len(accounts)} account(s), billing {billing}"
        else:
            who = "no account — `/workbuddy login " + region + "`"
        lines.append(f"  {region:<6} {info['baseUrl']} · {models} model(s) · {who} · /model {prefix}-<model>")
    stamp = _checkin_stamp()
    auto = "on" if _checkin_auto_enabled() else "off"
    lines.append(
        f"  check-in: auto {auto}"
        + (f" · last run {stamp}" if stamp else "")
        + " · `/workbuddy checkin` claims today now"
    )
    lines.append(
        f"  travel:   auto {'on' if _travel_auto_enabled() else 'off'}"
        + (f" · last run {_travel_stamp()}" if _travel_stamp() else "")
        + _travel_due_text()
        + " · `/workbuddy travel` claims + dispatches the 派猫猫 buddy"
    )
    return "\n".join(lines)


def _refresh_aliases_text() -> str:
    token = _read_token()
    regions = _regions_from_state(_read_state())
    if not token or not regions:
        return "WorkBuddy is not set up yet — run `hermes workbuddy install`."
    models = {region: _fetch_models(info["baseUrl"], token) for region, info in regions.items()}
    _wire_config(regions, models)
    total = sum(len(ids) for ids in models.values())
    return (
        f"Refreshed {total} model alias(es) from the live catalog — "
        "`/model wb-…` (domestic) and `/model wbg-…` (global) now resolve."
    )


def _login(region: str) -> str:
    """Start the browser sign-in detached and hand the user its URL.

    The gateway's ``login`` verb polls the WorkBuddy OAuth endpoint until the
    browser flow finishes, so it must outlive the slash command: it runs as its
    own session and writes both the URL file and its output under the state dir.
    """
    if not _ensure_running():
        return f"WorkBuddy gateway could not start; see {_log_path()} (or `hermes workbuddy logs`)."
    region = "global" if region == "global" else "cn"
    url_path = _state_dir() / f"login-{region}-url.txt"
    log_path = _state_dir() / f"login-{region}.log"
    with contextlib.suppress(OSError):
        url_path.unlink()
    try:
        _state_dir().mkdir(parents=True, exist_ok=True)
        handle = open(log_path, "ab")  # noqa: SIM115 - the child keeps its own descriptor
        try:
            subprocess.Popen(
                [_node(), str(_gateway_dir() / "lib" / "bin.js"), "login", "--region", region],
                cwd=str(_gateway_dir()),
                env=_node_env(),
                stdin=subprocess.DEVNULL,
                stdout=handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            handle.close()
    except OSError as error:
        return f"Could not start the WorkBuddy sign-in: {error}"
    url = ""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with contextlib.suppress(OSError):
            url = url_path.read_text().strip()
        if url:
            break
        time.sleep(0.25)
    if not url:
        return f"Sign-in started ({region}) but no URL appeared yet — see {log_path}."
    return (
        f"Sign-in started ({region}). Open this URL in a browser and finish the login there:\n\n"
        f"  {url}\n\n"
        "The account is stored the moment the browser flow completes — no further step here. "
        "`/workbuddy account` then lists it, and `/workbuddy aliases` picks up any new models."
    )


def _all_accounts() -> list[dict[str, Any]]:
    """Every stored account across the configured regions, region-tagged."""
    regions = sorted(_regions_from_state(_read_state())) or sorted(DEFAULT_PORTS)
    rows: list[dict[str, Any]] = []
    for region in regions:
        for account in _list_accounts(region):
            rows.append({**account, "region": region})
    return rows


def _account_label(account: dict[str, Any]) -> str:
    flags = " [selected]" if account.get("selected") else ""
    if account.get("enterprise"):
        flags += " [enterprise]"
    return f"{_region_label(account['region'])} · {account['name']}{flags}"


def _account_table(accounts: list[dict[str, Any]]) -> str:
    return "\n".join(f"  {index}. {_account_label(account)}" for index, account in enumerate(accounts, 1))


def _match_account(accounts: list[dict[str, Any]], target: str) -> Optional[dict[str, Any]]:
    """Resolve a typed target: 1-based index, account id (or its prefix), or a name fragment."""
    token = (target or "").strip()
    if not token:
        return None
    if token.isdigit() and 1 <= int(token) <= len(accounts):
        return accounts[int(token) - 1]
    for account in accounts:
        if account["id"] == token or account["id"].startswith(token):
            return account
    lowered = token.casefold()
    return next((account for account in accounts if lowered in account["name"].casefold()), None)


def _apply_account(region: str, account_id: str) -> str:
    """Persist one region's billing account and say when it takes effect."""
    code, out, err = _gateway_capture("account", "--region", region, account_id, timeout=15)
    text = (out or err).strip()
    if code != 0:
        return text or f"workbuddy: could not select {account_id} ({region})"
    return f"{text}\nA running gateway bills the new account from its next request."


def _clear_account(region: str) -> str:
    """Drop the explicit selection so the newest sign-in pays again."""
    _code, out, err = _gateway_capture("account", "--region", region, "--clear", timeout=15)
    return (out or err).strip() or f"workbuddy: nothing to clear ({region})"


def _switch_account(ctx: Any, region: Optional[str] = None, target: str = "") -> str:
    """Pick which stored account pays — one picker across CN and global.

    Passing ``region`` narrows the list; passing ``target`` skips the picker
    entirely (1-based index, account id prefix, or name fragment), which is what
    makes ``/workbuddy account 2`` a single keystroke switch.
    """
    if region in ("cn", "global"):
        accounts = [{**account, "region": region} for account in _list_accounts(region)]
    else:
        accounts = _all_accounts()
    if not accounts:
        return "No stored account yet — `/workbuddy login` signs one in through the browser."
    if target:
        match = _match_account(accounts, target)
        if match is None:
            return f"No account matches {target!r}. Stored accounts:\n{_account_table(accounts)}"
        return _apply_account(match["region"], match["id"])
    choices = [
        {
            "value": f"{account['region']}:{account['id']}",
            "label": _account_label(account),
            "description": account["summary"] or account["id"],
        }
        for account in accounts
    ]
    for region_name in sorted({account["region"] for account in accounts if account.get("selected")}):
        choices.append(
            {
                "value": f"clear:{region_name}",
                "label": f"{_region_label(region_name)} · follow the newest sign-in (clear)",
                "description": "drop the explicit choice; the next sign-in takes over",
            }
        )
    chosen = ctx.ask_choice("Which account should pay for requests?", choices)
    if not chosen:
        return _status_text()
    action, _, value = str(chosen).partition(":")
    if action == "clear":
        return _clear_account(value)
    return _apply_account(action, value)


# ── One-click check-in ────────────────────────────────────────────────
#
# The gateway's `checkin` verb is already idempotent (it asks upstream whether
# today was claimed and only writes when it was not), so it is safe to fire from
# a menu item, a slash verb, or once a day from the watchdog thread.


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _checkin_auto_enabled() -> bool:
    env = os.environ.get(CHECKIN_AUTO_ENV, "").strip().lower()
    if env in ("0", "false", "no", "off", "disabled"):
        return False
    if env in ("1", "true", "yes", "on"):
        return True
    return _read_flag(CHECKIN_AUTO_MARKER) == "on"


def _checkin_stamp() -> str:
    return _read_flag(CHECKIN_STAMP) or ""


def _checkin_report(region: str = "both") -> tuple[dict[str, list[dict[str, Any]]], int, str]:
    """Run the gateway's check-in; return ``(rows by region, exit code, raw text)``."""
    code, out, err = _gateway_capture("checkin", "--region", region, "--json", timeout=180)
    raw = (out or err).strip()
    try:
        report = json.loads(out)
    except (TypeError, ValueError):
        return {}, code, raw
    if not isinstance(report, dict):
        return {}, code, raw
    rows = {
        name: [row for row in value if isinstance(row, dict)]
        for name, value in report.items()
        if isinstance(value, list)
    }
    return rows, code, raw


def _checkin_row_line(region: str, row: dict[str, Any]) -> str:
    who = row.get("accountName") or row.get("accountId") or "?"
    status = str(row.get("status") or "")
    if status == "claimed":
        detail = ""
        credit = row.get("credit")
        if isinstance(credit, (int, float)):
            detail += f" +{credit:g} credit"
        streak = row.get("streakDays")
        if isinstance(streak, (int, float)):
            detail += f" (streak {int(streak)}d)"
        return f"  {_region_label(region)} · {who}: claimed{detail}"
    if status == "already":
        return f"  {_region_label(region)} · {who}: already claimed today"
    if status == "skipped":
        return f"  {_region_label(region)} · {who}: skipped — {row.get('message') or 'no check-in for this account'}"
    return f"  {_region_label(region)} · {who}: not claimed — {row.get('message') or 'unknown reason'}"


def _checkin_card(rows: dict[str, list[dict[str, Any]]], code: int) -> str:
    """Render an already-claimed report (``region -> rows``) as one card."""
    lines = [f"WorkBuddy check-in · {_today()}"]
    gained = 0.0
    claimed = 0
    for name in sorted(rows):
        region_rows = rows[name]
        if not region_rows:
            lines.append(f"  {_region_label(name)}: no stored account — `/workbuddy login {name}`")
            continue
        for row in region_rows:
            lines.append(_checkin_row_line(name, row))
            if row.get("status") == "claimed":
                claimed += 1
                credit = row.get("credit")
                if isinstance(credit, (int, float)):
                    gained += float(credit)
    if claimed:
        lines.append(f"{claimed} account(s) claimed" + (f", +{gained:g} credit today" if gained else ""))
    else:
        lines.append("Nothing left to claim today." if code == 0 or rows else "Nothing claimable — see above.")
    lines.append(
        "auto: on (claims once a day)" if _checkin_auto_enabled()
        else "auto: off — `/workbuddy checkin auto on` claims it daily by itself"
    )
    return "\n".join(lines)


def _checkin_text(region: str = "both") -> str:
    """Claim today's reward on every account and report it in one card."""
    rows, code, raw = _checkin_report(region)
    if not rows:
        return raw or "workbuddy: no check-in report"
    return _checkin_card(rows, code)


def _run_checkin(
    region: str = "both",
    *,
    travel: bool = False,
    location: Optional[int] = None,
    announce: bool = True,
) -> str:
    """Check in, optionally run the travel loop, and push the result if configured."""
    rows, code, raw = _checkin_report(region)
    if not rows:
        return raw or "workbuddy: no check-in report"
    text = _checkin_card(rows, code)
    ok = not any(row.get("status") == "failed" for region_rows in rows.values() for row in region_rows)
    if announce:
        note = _notify_after("WorkBuddy 签到", text, ok=ok)
        if note:
            text += "\n" + note
    if travel:
        travel_text, _ok = _run_travel(region, location=location, announce=announce)
        text += "\n\n" + travel_text
    return text


def _checkin_auto_text(mode: str = "status") -> str:
    """Turn the daily claim on or off (marker file), or report it."""
    if mode in ("on", "off"):
        _write_flag(CHECKIN_AUTO_MARKER, mode)
        if mode == "on":
            return _checkin_text("both") + "\n\nauto: on — the watchdog thread claims once a day from now on."
        return "auto: off — `/workbuddy checkin` still claims on demand."
    auto = _checkin_auto_enabled()
    stamp = _checkin_stamp()
    return (
        f"auto: {'on' if auto else 'off'}"
        f" · last dated run {stamp or 'never'}"
        f" · log {_state_dir() / CHECKIN_LOG}"
    )


def _auto_checkin_tick() -> None:
    """Claim once per day when daily mode is on (called from the watchdog thread)."""
    if not _checkin_auto_enabled():
        return
    today = _today()
    if _checkin_stamp() == today:
        return
    # Stamp first: a failed run must not re-fire on every watchdog tick.
    _write_flag(CHECKIN_STAMP, today)
    rows, _code, raw = _checkin_report("both")
    summary = ", ".join(
        f"{name}:{row.get('accountName') or row.get('accountId')}={row.get('status')}"
        for name, region_rows in rows.items()
        for row in region_rows
    ) or (raw or "no rows")
    with contextlib.suppress(OSError):
        _state_dir().mkdir(parents=True, exist_ok=True)
        with (_state_dir() / CHECKIN_LOG).open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {summary}\n")


# ── Buddy travel (派猫猫) ─────────────────────────────────────────────
#
# Same shape as check-in — one row per account per region — but the loop is a
# closed one: claim a landed reward FIRST, then dispatch. Both happen inside the
# gateway (it owns the credentials and the refresh), so this layer only renders
# and schedules.


def _travel_auto_enabled() -> bool:
    env = os.environ.get(TRAVEL_AUTO_ENV, "").strip().lower()
    if env in ("0", "false", "no", "off", "disabled"):
        return False
    if env in ("1", "true", "yes", "on"):
        return True
    return _read_flag(TRAVEL_AUTO_MARKER) == "on"


def _travel_stamp() -> str:
    return _read_flag(TRAVEL_STAMP) or ""


def _travel_next() -> Optional[int]:
    """When the next auto check is due (epoch ms), or None when not waiting."""
    raw = _read_flag(TRAVEL_NEXT)
    if not raw:
        return None
    try:
        return int(float(raw))
    except ValueError:
        return None


def _travel_report(
    region: str = "both", *, status_only: bool = False, location: Optional[int] = None
) -> tuple[dict[str, list[dict[str, Any]]], int, str]:
    """Run the gateway's travel loop; return ``(rows by region, exit code, raw text)``."""
    argv = ["travel", "--region", region, "--json"]
    if status_only:
        argv.append("--status")
    if location is not None:
        argv.extend(["--location", str(int(location))])
    code, out, err = _gateway_capture(*argv, timeout=240)
    raw = (out or err).strip()
    try:
        report = json.loads(out)
    except (TypeError, ValueError):
        return {}, code, raw
    if not isinstance(report, dict):
        return {}, code, raw
    rows = {
        name: [row for row in value if isinstance(row, dict)]
        for name, value in report.items()
        if isinstance(value, list)
    }
    return rows, code, raw


def _travel_row_line(region: str, row: dict[str, Any]) -> str:
    who = row.get("accountName") or row.get("accountId") or "?"
    status = str(row.get("status") or "?")
    detail = ""
    credit = row.get("credit")
    if isinstance(credit, (int, float)) and credit:
        detail += f" +{credit:g} credit"
    location = row.get("location")
    if isinstance(location, str) and location:
        detail += f" · {location}"
    if row.get("departed") is True:
        detail += " → dispatched"
    arrive = row.get("arriveAtMs")
    if isinstance(arrive, (int, float)) and arrive > 0:
        detail += " · lands " + time.strftime("%m-%d %H:%M", time.localtime(arrive / 1000))
    message = row.get("message")
    if isinstance(message, str) and message:
        detail += f" — {message}"
    return f"  {_region_label(region)} · {who}: {status}{detail}"


def _travel_card(rows: dict[str, list[dict[str, Any]]], *, status_only: bool = False) -> str:
    lines = [
        f"WorkBuddy 派猫猫 · {_today()}" + (" · status only (nothing claimed or dispatched)" if status_only else "")
    ]
    moved = 0
    failed = 0
    for name in sorted(rows):
        region_rows = rows[name]
        if not region_rows:
            lines.append(f"  {_region_label(name)}: no stored account — `/workbuddy login {name}`")
            continue
        for row in region_rows:
            lines.append(_travel_row_line(name, row))
            if row.get("status") == "failed":
                failed += 1
            elif row.get("status") in ("claimed", "departed") or row.get("departed") is True:
                moved += 1
    if moved:
        lines.append(f"{moved} account(s) claimed or dispatched this run")
    elif not status_only:
        lines.append("Nothing to claim or dispatch this run (traveling, or the daily cap is used up).")
    if failed:
        lines.append(f"{failed} account(s) failed — the upstream's words are above.")
    lines.append(
        "auto: on (runs once a day with the watchdog)" if _travel_auto_enabled()
        else "auto: off — `/workbuddy travel auto on` runs the loop daily by itself"
    )
    return "\n".join(lines)


def _notify_after(title: str, text: str, *, ok: bool) -> str:
    """Push a run summary when the user configured channels; '' means silent."""
    try:
        return _notify.notify_report(title, text, success=ok)
    except Exception:  # a push must never change the run's outcome
        logger.warning("workbuddy: notify failed", exc_info=True)
        return ""


def _run_travel(
    region: str = "both",
    *,
    status_only: bool = False,
    location: Optional[int] = None,
    announce: bool = True,
) -> tuple[str, bool]:
    """Render one travel run (and push it when configured). Returns ``(text, ok)``."""
    rows, code, raw = _travel_report(region, status_only=status_only, location=location)
    if not rows:
        return raw or "workbuddy: no travel report", False
    text = _travel_card(rows, status_only=status_only)
    ok = not any(row.get("status") == "failed" for region_rows in rows.values() for row in region_rows)
    if announce and not status_only:
        note = _notify_after("WorkBuddy 派猫猫", text, ok=ok)
        if note:
            text += "\n" + note
    return text, ok


def _travel_due_text() -> str:
    due = _travel_next()
    if due is None:
        return ""
    return " · next auto check " + time.strftime("%m-%d %H:%M", time.localtime(due / 1000))


def _travel_auto_text(mode: str = "status") -> str:
    """Arm the daily travel loop (marker file) or report it."""
    if mode in ("on", "off"):
        _write_flag(TRAVEL_AUTO_MARKER, mode)
        if mode == "on":
            rows, _code, raw = _travel_report("both")
            if not rows:
                return (raw or "workbuddy: no travel report") + "\n\nauto: on — nothing to run yet."
            text = _travel_card(rows)
            ok = not any(row.get("status") == "failed" for region_rows in rows.values() for row in region_rows)
            note = _notify_after("WorkBuddy 派猫猫", text, ok=ok)
            _record_travel_outcome(rows)
            if note:
                text += "\n" + note
            return (
                text
                + "\n\nauto: on — the watchdog runs this loop once a day"
                + (" (a trip is in the air: the next check is set for just after it lands)"
                   if _travel_next() is not None else "")
                + _travel_due_text()
            )
        return "auto: off — `/workbuddy travel` still runs on demand."
    return (
        f"auto: {'on' if _travel_auto_enabled() else 'off'}"
        f" · last dated run {_travel_stamp() or 'never'}"
        + _travel_due_text()
        + f" · log {_state_dir() / TRAVEL_LOG}"
    )


def _auto_travel_tick() -> None:
    """Run the travel loop once per day when armed (called from the watchdog)."""
    if not _travel_auto_enabled():
        return
    due = _travel_next()
    if due is not None and int(time.time() * 1000) < due:
        return  # a trip is still in the air; nothing to do until it lands
    if due is None and _travel_stamp() == _today():
        return
    rows, _code, raw = _travel_report("both")
    if not rows:
        _log_travel(f"ok=False {raw}".strip())
        return
    text = _travel_card(rows)
    ok = not any(row.get("status") == "failed" for region_rows in rows.values() for row in region_rows)
    _notify_after("WorkBuddy 派猫猫", text, ok=ok)
    _record_travel_outcome(rows)
    _log_travel(f"ok={ok} {' '.join(text.split())}")


def _record_travel_outcome(rows: dict[str, list[dict[str, Any]]]) -> None:
    """Decide when the next automatic run is due, from this run's rows.

    A trip in flight is the interesting case: claiming is only possible once it
    lands, so stamping "done for today" the moment a run finds `traveling` would
    strand the reward for the rest of the day. Instead the arrival instant is
    remembered and the watchdog wakes up just after it — landing, claiming and
    dispatching in one go, which is also what keeps a fresh trip going.
    """
    pending: Optional[int] = None
    for region_rows in rows.values():
        for row in region_rows:
            arrive = row.get("arriveAtMs")
            if row.get("status") == "traveling" and isinstance(arrive, (int, float)) and arrive > 0:
                due = int(arrive) + 60_000
                pending = due if pending is None else min(pending, due)
    if pending is not None:
        _write_flag(TRAVEL_NEXT, str(pending))
        return
    _write_flag(TRAVEL_NEXT, None)
    _write_flag(TRAVEL_STAMP, _today())


def _log_travel(line: str) -> None:
    with contextlib.suppress(OSError):
        _state_dir().mkdir(parents=True, exist_ok=True)
        with (_state_dir() / TRAVEL_LOG).open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {line}\n")



def _choose_region(ctx: Any, question: str) -> str:
    regions = sorted(_regions_from_state(_read_state())) or ["cn"]
    if len(regions) == 1:
        return regions[0]
    picked = ctx.ask_choice(question, [{"value": r, "label": _region_label(r)} for r in regions])
    return picked if picked in regions else regions[0]


def _toggle_autostart(ctx: Any) -> str:
    chosen = ctx.ask_choice(
        "Autostart — keep the WorkBuddy gateway running with Hermes?",
        [
            {"value": "on", "label": "On", "description": "start on session start / gateway boot; watchdog restarts it"},
            {"value": "off", "label": "Off", "description": "leave the gateway alone; `stop` also shuts it down"},
        ],
    )
    if chosen == "on":
        _write_flag(AUTOSTART_MARKER, "on")
        try:
            hook = install_lifecycle_hook()
        except OSError as error:
            hook = f"could not install ({error})"
        started = _cmd_start(argparse.Namespace(port=DEFAULT_PORTS["cn"])) == 0
        return (
            f"autostart on — gateway {'running' if started else 'could not start'}; boot hook {hook}"
        )
    if chosen == "off":
        _write_flag(AUTOSTART_MARKER, "off")
        return "autostart off — a running gateway keeps serving; `/workbuddy stop` shuts it down."
    return _status_text()


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
    _write_flag(AUTOSTART_MARKER, "on")
    print("workbuddy: autostart on — the gateway comes up with Hermes (disable: hermes workbuddy autostart off)")
    print("workbuddy: in-session channel: /workbuddy (status, sign-in, billing account, aliases)")
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
    _write_flag(STOP_MARKER, None)  # an explicit start overrides a parked `stop`
    if _is_running():
        print(f"workbuddy: gateway already running (pid {_running_pid()})")
        return 0
    if _ensure_running(quiet=False, port=port, respect_stop=False):
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
    mode = getattr(args, "auto", None)
    if mode:
        print(_checkin_auto_text(mode))
        return 0
    region = getattr(args, "region", "both")
    travel = bool(getattr(args, "travel", False))
    location = getattr(args, "location", None)
    if travel or location:
        print(_run_checkin(region, travel=True, location=location))
        return 0
    rows, code, raw = _checkin_report(region)
    print(_run_checkin(region) if rows else (raw or "workbuddy: nothing checked in"))
    return 0 if rows else code


def _cmd_travel(args: argparse.Namespace) -> int:
    mode = getattr(args, "auto", None)
    if mode:
        print(_travel_auto_text(mode))
        return 0
    status_only = bool(getattr(args, "status", False))
    location = getattr(args, "location", None)
    text, ok = _run_travel(
        getattr(args, "region", "both"), status_only=status_only, location=location
    )
    print(text)
    return 0 if ok or status_only else 1


def _cmd_notify(args: argparse.Namespace) -> int:
    action = str(getattr(args, "notify_action", "") or "status")
    if action == "test":
        print(_notify.test_text())
        return 0
    print(_notify.status_text())
    return 0


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


def _cmd_account(args: argparse.Namespace) -> int:
    region = getattr(args, "region", "cn")
    if getattr(args, "clear", False):
        print(_clear_account(region))
        return 0
    target = str(getattr(args, "account", "") or "")
    if target:
        accounts = [{**account, "region": region} for account in _list_accounts(region)]
        match = _match_account(accounts, target)
        if match is None:
            print(
                f"workbuddy: no {region} account matches {target!r}\n{_account_table(accounts)}",
                file=sys.stderr,
            )
            return 2
        print(_apply_account(region, match["id"]))
        return 0
    return _run_gateway(["account", "--region", region]).returncode


# ── In-session channel: /workbuddy ────────────────────────────────────
#
# The operator CLI is one process away from a conversation, which made
# "change the account" mean "ask the model to shell out". This command is the
# in-conversation settings surface: `/workbuddy` prints the gateway card and
# offers the account operations through the host's own clarify picker (the CLI /
# TUI / desktop panel, or buttons on Telegram/Discord/Slack), so a sign-in or an
# account switch never needs a model turn — or a separate terminal.

SLASH_MENU: tuple[dict[str, str], ...] = (
    {"value": "status", "label": "Status", "description": "gateway, accounts, autostart, live model counts"},
    {"value": "checkin", "label": "Daily check-in (签到)", "description": "claim every account's daily reward — one click, safe to repeat"},
    {"value": "travel", "label": "Buddy travel (派猫猫)", "description": "claim a landed reward, then dispatch the buddy again"},
    {"value": "account", "label": "Switch account (切换账号)", "description": "one picker across CN + global; the pick pays for requests"},
    {"value": "login", "label": "Sign in / add account (登录)", "description": "browser sign-in, stored when you finish there"},
    {"value": "aliases", "label": "Refresh models", "description": "re-read the live catalog into Hermes aliases"},
    {"value": "notify", "label": "Push notifications (推送)", "description": "channel readiness and a test push for check-in/travel runs"},
    {"value": "autostart", "label": "Autostart on/off", "description": "keep the gateway up with Hermes"},
)

SLASH_USAGE = """WorkBuddy — in-session settings (no model turn needed)
  /workbuddy                       status card + menu
  /workbuddy status
  /workbuddy checkin [cn|global]   claim today's reward on every account (一键签到)
  /workbuddy checkin travel        claim, then run the 派猫猫 travel loop
  /workbuddy checkin auto [on|off] claim once a day by itself
  /workbuddy travel [status]       Buddy travel (派猫猫): claim a landed reward, then dispatch
  /workbuddy travel auto [on|off]  run the loop once a day by itself
  /workbuddy notify [status|test]  push channels for check-in/travel runs (推送)
  /workbuddy account [cn|global] [<index>|<id>|<name>|clear]
  /workbuddy login [cn|global]     browser sign-in; the account is stored when you finish
  /workbuddy aliases               re-read the live catalog into Hermes model aliases
  /workbuddy models [cn|global]
  /workbuddy credits
  /workbuddy autostart [on|off]
  /workbuddy start | stop | restart | logs
  /workbuddy logout                delete every stored credential (asks first)
  Chinese verbs work too: 状态 签到 账号 登录 积分 派猫猫 推送"""


def _pick_region_arg(tokens: list[str]) -> Optional[str]:
    for token in tokens:
        if token.lower() in ("cn", "global"):
            return token.lower()
    return None


def _slash_menu(ctx: Any) -> str:
    card = _status_text()
    action = ctx.ask_choice("WorkBuddy — what do you want to do?", list(SLASH_MENU))
    if not action:
        return card
    if action == "checkin":
        return _run_checkin("both")
    if action == "travel":
        return _run_travel("both")[0]
    if action == "notify":
        return _notify.status_text()
    if action == "login":
        return _login(_choose_region(ctx, "Sign in to which region?"))
    if action == "account":
        return _switch_account(ctx)
    if action == "aliases":
        return _refresh_aliases_text()
    if action == "autostart":
        return _toggle_autostart(ctx)
    return card



def build_slash_command(ctx: Any):
    """``/workbuddy ...`` handler bound to this plugin's context (for ``ask_choice``)."""

    def handler(raw_args: str, **_kwargs: Any) -> str:
        try:
            return _slash_invoke(ctx, raw_args)
        except SystemExit as stop:  # _node()'s "no Node.js" exits must not kill the session
            return f"workbuddy: {stop.code or 'the gateway could not start'}"
        except Exception as error:  # a slash command reports, never breaks the session
            logger.warning("workbuddy: /workbuddy %r failed", raw_args, exc_info=True)
            return f"workbuddy: {error}"

    return handler


def _slash_invoke(ctx: Any, raw_args: str) -> str:
    """Route one ``/workbuddy`` invocation (``raw_args`` is everything after the name)."""

    tokens = [token for token in (raw_args or "").split() if token]
    verb = tokens[0].lower().lstrip("/") if tokens else ""
    rest = tokens[1:]
    region = _pick_region_arg(rest)
    if verb in ("", "menu", "settings", "菜单", "设置"):
        return _slash_menu(ctx)
    if verb in ("status", "s", "状态"):
        return _status_text()
    if verb in ("help", "?", "帮助"):
        return SLASH_USAGE
    if verb in ("login", "signin", "登录", "登陆"):
        return _login(region or _choose_region(ctx, "Sign in to which region?"))
    if verb in ("account", "accounts", "账号", "账户", "切换"):
        if "clear" in rest or "清空" in rest:
            chosen = region or _choose_region(ctx, "Clear the billing account for which region?")
            return _clear_account(chosen)
        target = next((t for t in rest if t.lower() not in ("cn", "global")), "")
        return _switch_account(ctx, region, target)
    if verb in ("aliases", "刷新"):
        return _refresh_aliases_text()
    if verb in ("models", "模型"):
        _code, out, err = _gateway_capture("models", "--region", region or "cn")
        return (out or err).strip() or "workbuddy: no model list"
    if verb in ("credits", "积分", "额度"):
        _code, out, err = _gateway_capture("credits", "--region", region or "both", timeout=60)
        return (out or err).strip() or "workbuddy: no credit report"
    if verb in ("checkin", "check-in", "签到", "打卡", "领取"):
        mode = next((t.lower() for t in rest if t.lower() in ("on", "off")), "")
        if mode or any(t.lower() in ("auto", "每日", "自动") for t in rest):
            return _checkin_auto_text(mode or "status")
        wants_travel = any(t.lower() in ("travel", "旅行", "猫猫", "派猫猫") for t in rest)
        location = next((int(t) for t in rest if t.isdigit() and 1 <= int(t) <= 4), None)
        if wants_travel or location is not None:
            return _run_checkin(region or "both", travel=True, location=location)
        return _run_checkin(region or "both")
    if verb in ("travel", "派猫猫", "旅行", "猫猫"):
        mode = next((t.lower() for t in rest if t.lower() in ("on", "off")), "")
        if mode or any(t.lower() in ("auto", "每日", "自动") for t in rest):
            return _travel_auto_text(mode or "status")
        if any(t.lower() in ("status", "state", "状态") for t in rest):
            return _run_travel(region or "both", status_only=True)[0]
        location = next((int(t) for t in rest if t.isdigit() and 1 <= int(t) <= 4), None)
        return _run_travel(region or "both", location=location)[0]
    if verb in ("notify", "push", "推送", "通知"):
        action = next((t.lower() for t in rest if t.lower() in ("status", "test")), "")
        return _notify.test_text() if action == "test" else _notify.status_text()

    if verb == "autostart":
        mode = next((t.lower() for t in rest if t.lower() in ("on", "off")), "")
        if mode == "on":
            _write_flag(AUTOSTART_MARKER, "on")
            hook = ""
            try:
                hook = install_lifecycle_hook()
            except OSError as error:
                hook = f"could not install ({error})"
            _cmd_start(argparse.Namespace(port=DEFAULT_PORTS["cn"]))
            return f"autostart on — gateway running, boot hook {hook}"
        if mode == "off":
            _write_flag(AUTOSTART_MARKER, "off")
            return "autostart off — a running gateway keeps serving; `/workbuddy stop` shuts it down."
        return _toggle_autostart(ctx)
    if verb in ("start", "stop", "restart"):
        if verb == "start":
            _cmd_start(argparse.Namespace(port=DEFAULT_PORTS["cn"]))
        elif verb == "stop":
            _cmd_stop(argparse.Namespace())
        else:
            _cmd_restart(argparse.Namespace(port=DEFAULT_PORTS["cn"]))
        return _status_text()
    if verb == "logs":
        try:
            lines = _log_path().read_text().splitlines()[-20:]
        except OSError:
            return f"No gateway log yet at {_log_path()}."
        return "\n".join(lines) or "Gateway log is empty."
    if verb == "logout":
        confirmed = ctx.ask_choice(
            "Delete every stored WorkBuddy credential? The desktop app's own sign-in is untouched.",
            [{"value": "yes", "label": "Yes, sign out"}, {"value": "no", "label": "Cancel"}],
        )
        if confirmed != "yes":
            return _status_text()
        _code, out, err = _gateway_capture("logout", timeout=30)
        return (out or err).strip() or "workbuddy: signed out"
    return f"workbuddy: unknown subcommand {verb!r}\n\n{SLASH_USAGE}"




_COMMANDS = {
    "setup": _cmd_setup,
    "install": _cmd_setup,
    "login": _cmd_login,
    "start": _cmd_start,
    "stop": _cmd_stop,
    "restart": _cmd_restart,
    "status": _cmd_status,
    "logs": _cmd_logs,
    "models": _cmd_models,
    "credits": _cmd_credits,
    "checkin": _cmd_checkin,
    "travel": _cmd_travel,
    "notify": _cmd_notify,
    "aliases": _cmd_aliases,
    "account": _cmd_account,
    "autostart": _cmd_autostart,
}


def register_cli(subparser: argparse.ArgumentParser) -> None:
    subs = subparser.add_subparsers(dest="workbuddy_action")
    p = subs.add_parser("setup", help="Start the gateway and wire providers + aliases into Hermes")
    p = subs.add_parser("install", help="One command: setup + autostart wiring (idempotent repair)")
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
        ("checkin", "Claim every account's daily reward (one click)"),
        ("travel", "Buddy travel (派猫猫): claim a landed reward, then dispatch"),
    ):
        sub = subs.add_parser(name, help=help_text)
        sub.add_argument("--region", choices=("cn", "global", "both"), default="both")
        if name == "checkin":
            sub.add_argument(
                "--auto",
                choices=("on", "off", "status"),
                help="Claim once a day by itself (on|off) or report that mode",
            )
            sub.add_argument("--travel", action="store_true", help="Also run the travel loop")
            sub.add_argument("--location", type=int, choices=(1, 2, 3, 4), help="Travel destination id")
        if name == "travel":
            sub.add_argument("--status", action="store_true", help="Read-only: claim and dispatch nothing")
            sub.add_argument("--location", type=int, choices=(1, 2, 3, 4), help="Destination id (default: random)")
            sub.add_argument(
                "--auto",
                choices=("on", "off", "status"),
                help="Run the loop once a day by itself (on|off) or report that mode",
            )
    notify = subs.add_parser("notify", help="Message push for check-in/travel runs (status|test)")
    notify.add_argument("notify_action", nargs="?", choices=("status", "test"), default="status")
    account = subs.add_parser("account", help="List, select, or clear a region's billing account")
    account.add_argument("account", nargs="?", help="Account id or name (omit to list)")
    account.add_argument("--region", choices=("cn", "global"), default="cn")
    account.add_argument("--clear", action="store_true", help="Follow the newest sign-in again")
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
