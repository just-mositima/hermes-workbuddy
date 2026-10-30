"""WorkBuddy Models plugin.

Registers two surfaces over one bundled Node gateway:

* the operator CLI (`hermes workbuddy ...`): setup/install, start/stop,
  login, account, model listing, credit/check-in passthrough;
* the in-session slash command (`/workbuddy`): the same account operations
  through the host's own clarify picker, so updating a sign-in never needs a
  model turn.

The plugin also keeps that gateway alive alongside Hermes (session-start and
pre-request hooks, a boot hook under ``$HERMES_HOME/hooks`` and a watchdog
thread), so a wb-* / wbg-* model never meets a dead loopback endpoint after a
restart — whichever surface started the process.
"""

from __future__ import annotations

import logging

from .cli import build_slash_command, install_autostart, register_cli, workbuddy_command

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
        ctx.register_command(
            "workbuddy",
            build_slash_command(ctx),
            description=(
                "WorkBuddy gateway and accounts: status, one-click daily check-in, "
                "browser sign-in, account switch, model aliases, autostart"
            ),
            args_hint="[status|checkin|account|login|aliases|models|credits|autostart|logout]",
        )
    except Exception:  # an older host without register_command keeps the CLI
        logger.warning("workbuddy: could not register /workbuddy", exc_info=True)
    try:
        install_autostart(ctx)
    except Exception:  # autostart is a convenience — never break plugin loading
        logger.warning("workbuddy: autostart wiring failed", exc_info=True)
