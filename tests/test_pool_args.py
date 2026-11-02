"""``_pool_args``: the account-pool default that ships with ``start``/``restart``.

``gateway serve`` enables pool rotation unless ``--no-pool`` is passed, and rotation
outranks the user's selection on every request (``prepareAccount`` ranks the local
sign-ins by remaining credit and overrides the pick). Without the flag the CLI's
``account --region <r> <id>`` looked applied while a different account was billed, so
the starter passes ``--no-pool`` unless ``WORKBUDDY_POOL`` opts back in.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cli  # noqa: E402  (path set above)


class PoolArgsTest(unittest.TestCase):
    def _args(self, value: str | None) -> list[str]:
        env = dict(os.environ)
        env.pop(cli.POOL_ENV, None)
        if value is not None:
            env[cli.POOL_ENV] = value
        with mock.patch.dict(os.environ, env, clear=True):
            return cli._pool_args()

    def test_rotation_is_off_by_default(self) -> None:
        self.assertEqual(self._args(None), ["--no-pool"])
        self.assertEqual(self._args(""), ["--no-pool"])

    def test_opt_in_values_drop_the_flag(self) -> None:
        for value in ("1", "on", "true", "yes", "TRUE"):
            self.assertEqual(self._args(value), [], value)

    def test_other_values_keep_rotation_off(self) -> None:
        for value in ("0", "off", "false", "no", "anything"):
            self.assertEqual(self._args(value), ["--no-pool"], value)


if __name__ == "__main__":
    unittest.main()
