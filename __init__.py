"""WorkBuddy Models plugin.

Registers the operator CLI (`hermes workbuddy ...`): setup, start/stop,
login, model listing, credit/check-in passthrough. The model traffic itself
is served by the bundled Node gateway, never by this Python module.

The plugin also keeps that gateway alive alongside Hermes (session-start and
pre-request hooks plus a watchdog thread), so a wb-* / wbg-* model never meets
a dead loopback endpoint after a restart.
"""

from __future__ import annotations

import logging

from .cli import install_autostart, register_cli, workbuddy_command

logger = logging.getLogger("hermes.plugins.workbuddy")


def register(ctx) -> None:
    ctx.register_cli_command(
        name="workbuddy",
        help="WorkBuddy models as an OpenAI-compatible provider for Hermes",
        setup_fn=register_cli,
        handler_fn=workbuddy_command,
        description=(
            "Manage the WorkBuddy gateway: first-time setup (start the loopback "
            "gateway and wire providers + model aliases into Hermes), browser "
            "sign-in, start/stop/status, live model and credit listing."
        ),
    )
    try:
        install_autostart(ctx)
    except Exception:  # autostart is a convenience — never break plugin loading
        logger.warning("workbuddy: autostart wiring failed", exc_info=True)
