"""Gateway lifecycle hook: keep the WorkBuddy sidecar up.

``hermes workbuddy autostart on`` copies this directory into
``$HERMES_HOME/hooks/workbuddy-autostart``. Hermes loads every
``$HERMES_HOME/hooks/<name>/`` dir and dispatches the events declared in
HOOK.yaml. The WorkBuddy gateway is a separate Node process, so nothing restarts
it after a container restart — this hook is that trigger.

Design notes:
* Idempotent by construction: it shells out to ``hermes workbuddy start``, which
  exits immediately when the gateway is already serving.
* Cheap on the common path: a loopback connect test decides whether to spawn at
  all, plus a short cooldown so a burst of ``session:start`` events cannot fork
  a CLI process per conversation.
* Never blocks the gateway: Popen with ``start_new_session``, output appended to
  ``$HERMES_HOME/workbuddy/autostart.log``.
* Honours both off switches: ``WORKBUDDY_AUTOSTART=0`` and
  ``hermes workbuddy autostart off`` (the ``autostart`` marker file).
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from datetime import datetime
from pathlib import Path

EVENTS = ("gateway:startup", "session:start")
DEFAULT_PORTS = (8787, 8788)
COOLDOWN_SECONDS = 15.0
_last_dispatch = 0.0


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or "/opt/data")


def _state_dir() -> Path:
    return _hermes_home() / "workbuddy"


def _log_path() -> Path:
    return _state_dir() / "autostart.log"


def _log(message: str) -> None:
    try:
        _log_path().parent.mkdir(parents=True, exist_ok=True)
        with open(_log_path(), "a", encoding="utf-8") as handle:
            handle.write(f"{datetime.now().isoformat(timespec='seconds')} {message}\n")
    except OSError:
        pass


def _flag(name: str) -> str:
    try:
        return (_state_dir() / name).read_text().strip().lower()
    except OSError:
        return ""


def _autostart_disabled() -> bool:
    if os.environ.get("WORKBUDDY_AUTOSTART", "").strip().lower() in (
        "0", "false", "no", "off", "disabled",
    ):
        return True
    return _flag("autostart") == "off"


def _stopped_by_operator() -> bool:
    return _flag("stopped") == "stop"


def _region_ports() -> tuple[int, ...]:
    try:
        state = json.loads((_state_dir() / "gateway.json").read_text())
    except (OSError, ValueError):
        return DEFAULT_PORTS
    ports = []
    for info in (state.get("regions") or {}).values():
        base_url = str((info or {}).get("baseUrl") or "")
        if ":" in base_url:
            tail = base_url.rsplit(":", 1)[-1].split("/")[0]
            if tail.isdigit():
                ports.append(int(tail))
    return tuple(ports) or DEFAULT_PORTS


def _serving() -> bool:
    for port in _region_ports():
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return True
        except OSError:
            continue
    return False


def _hermes_exe() -> str:
    for candidate in (shutil.which("hermes"), "/opt/hermes/bin/hermes", "/usr/local/bin/hermes"):
        if candidate and os.access(candidate, os.X_OK):
            return candidate
    return "hermes"


def handle(event_type: str, context: dict | None = None) -> None:
    global _last_dispatch
    if _autostart_disabled() or _stopped_by_operator():
        return
    if event_type != "gateway:startup" and time.monotonic() - _last_dispatch < COOLDOWN_SECONDS:
        return
    if _serving():
        return
    env = dict(os.environ)
    env.setdefault("HERMES_HOME", str(_hermes_home()))
    handle_out = None
    try:
        _state_dir().mkdir(parents=True, exist_ok=True)
        handle_out = open(_log_path(), "ab", buffering=0)
        subprocess.Popen(
            [_hermes_exe(), "workbuddy", "start"],
            env=env,
            cwd=str(_hermes_home()),
            stdin=subprocess.DEVNULL,
            stdout=handle_out,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
        _last_dispatch = time.monotonic()
        _log(f"{event_type}: dispatched `hermes workbuddy start`")
    except Exception as exc:  # a hook must never break the gateway
        _log(f"{event_type}: could not start the WorkBuddy gateway — {exc!r}")
    finally:
        if handle_out is not None:
            try:
                handle_out.close()  # the child holds its own descriptor
            except OSError:
                pass
