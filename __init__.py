"""WorkBuddy Models plugin.

Registers the operator CLI (`hermes workbuddy ...`): setup, start/stop,
login, model listing, credit/check-in passthrough. The model traffic itself
is served by the bundled Node gateway, never by this Python module.
"""

from __future__ import annotations

from .cli import register_cli, workbuddy_command


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
