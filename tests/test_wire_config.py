"""The config half of ``setup``: providers, the persisted roster, and aliases.

Regression guard for the "test passes, but the model switcher shows WorkBuddy CN /
WorkBuddy Global as 0 models" report: Hermes' pickers read a saved endpoint from the
provider-models disk cache only, and nothing ever persists a catalog for
``providers:`` entries (unlike ``custom_providers``). ``_wire_config`` therefore has
to write the live roster into the provider entry itself — ``models`` plus
``models_discovered`` — or the row renders empty until some other surface probes
``/v1/models``.

Runs without Hermes installed: ``hermes_cli.config`` is replaced by an in-memory
stub so the test only exercises this plugin's writer.
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cli  # noqa: E402  (path set above)


class _Store:
    """Stand-in for the profile's config.yaml, with Hermes' load/save contract."""

    def __init__(self, config: dict) -> None:
        self.config = config
        self.saves = 0

    def load_config(self) -> dict:
        import copy

        return copy.deepcopy(self.config)

    def save_config(self, config: dict, **_kwargs) -> None:
        self.saves += 1
        self.config = config


class WireConfigTest(unittest.TestCase):
    REGIONS = {
        "cn": {"baseUrl": "http://127.0.0.1:8787/v1"},
        "global": {"baseUrl": "http://127.0.0.1:8788/v1"},
    }

    def setUp(self) -> None:
        self.store = _Store(
            {
                "providers": {
                    "workbuddy": {"name": "WorkBuddy CN", "base_url": "http://127.0.0.1:8787/v1",
                                  "key_env": cli.TOKEN_ENV},
                    "workbuddy-global": {"name": "WorkBuddy Global",
                                         "base_url": "http://127.0.0.1:8788/v1",
                                         "key_env": cli.TOKEN_ENV},
                },
                "model_aliases": {
                    "fast": {"model": "glm-5.3", "provider": "workbuddy"},
                    "wb-stale": {"model": "gone-model", "provider": "workbuddy"},
                },
                "model": {"default": "wb", "provider": "workbuddy"},
                "agent": {"max_turns": 40},
            }
        )
        fake_pkg = types.ModuleType("hermes_cli")
        fake_cfg = types.ModuleType("hermes_cli.config")
        setattr(fake_cfg, "load_config", self.store.load_config)
        setattr(fake_cfg, "save_config", self.store.save_config)
        setattr(fake_pkg, "config", fake_cfg)
        self._saved = {name: sys.modules.get(name) for name in ("hermes_cli", "hermes_cli.config")}
        sys.modules["hermes_cli"] = fake_pkg
        sys.modules["hermes_cli.config"] = fake_cfg

    def tearDown(self) -> None:
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def _wire(self, models: dict) -> dict:
        cli._wire_config(self.REGIONS, models)
        return self.store.config

    def test_persists_the_roster_so_the_picker_is_not_empty(self) -> None:
        models = {"cn": ["hy3", "glm-5.3"], "global": ["hy3", "glm-5.2"]}
        config = self._wire(models)

        for region, provider_key in (("cn", "workbuddy"), ("global", "workbuddy-global")):
            entry = config["providers"][provider_key]
            self.assertEqual(sorted(entry["models"]), sorted(models[region]))
            # Hermes only treats a mapping as its own catalog (never an allowlist) when
            # this flag is set; without it the row would pin to the declared ids.
            self.assertIs(entry["models_discovered"], True)

        aliases = config["model_aliases"]
        self.assertEqual(aliases["wb"]["model"], "hy3")
        self.assertEqual(aliases["wbg"]["model"], "hy3")
        self.assertEqual(aliases["wb-glm-5.3"], {"model": "glm-5.3", "provider": "workbuddy"})
        self.assertEqual(aliases["wbg-glm-5.2"],
                         {"model": "glm-5.2", "provider": "workbuddy-global"})

    def test_retired_model_leaves_the_roster_and_the_aliases(self) -> None:
        self._wire({"cn": ["hy3", "old-model"], "global": ["hy3"]})
        config = self._wire({"cn": ["hy3", "new-model"], "global": ["hy3"]})

        self.assertEqual(sorted(config["providers"]["workbuddy"]["models"]), ["hy3", "new-model"])
        self.assertNotIn("wb-old-model", config["model_aliases"])
        self.assertIn("wb-new-model", config["model_aliases"])

    def test_empty_roster_keeps_what_was_wired(self) -> None:
        """A sign-out or an upstream hiccup must not blank a working row."""
        self._wire({"cn": ["hy3", "glm-5.3"], "global": ["hy3"]})
        config = self._wire({"cn": [], "global": []})

        self.assertEqual(sorted(config["providers"]["workbuddy"]["models"]), ["glm-5.3", "hy3"])
        self.assertEqual(list(config["providers"]["workbuddy-global"]["models"]), ["hy3"])
        self.assertIn("wb-glm-5.3", config["model_aliases"])
        self.assertIn("wbg", config["model_aliases"])

    def test_first_install_with_no_account_writes_no_roster(self) -> None:
        config = self._wire({"cn": [], "global": []})

        self.assertNotIn("models", config["providers"]["workbuddy"])
        self.assertIs(config["providers"]["workbuddy"]["key_env"], cli.TOKEN_ENV)
        self.assertEqual(config["providers"]["workbuddy"]["base_url"], "http://127.0.0.1:8787/v1")

    def test_other_sections_and_foreign_aliases_survive(self) -> None:
        config = self._wire({"cn": ["hy3"], "global": []})

        self.assertEqual(config["model"], {"default": "wb", "provider": "workbuddy"})
        self.assertEqual(config["agent"], {"max_turns": 40})
        self.assertEqual(config["model_aliases"]["fast"]["model"], "glm-5.3")

    def test_per_model_metadata_is_preserved_across_refreshes(self) -> None:
        self.store.config["providers"]["workbuddy"]["models"] = {"hy3": {"context_length": 128000}}
        config = self._wire({"cn": ["hy3"], "global": []})

        self.assertEqual(config["providers"]["workbuddy"]["models"]["hy3"], {"context_length": 128000})

    def test_roster_missing_flags_an_upgraded_install_only(self) -> None:
        wired = {"providers": {"workbuddy": {"models": {"hy3": {}}},
                               "workbuddy-global": {"models": {"hy3": {}}}}}
        self.assertFalse(cli._provider_roster_missing(wired))
        self.assertTrue(cli._provider_roster_missing({"providers": {"workbuddy": {"base_url": "x"}}}))
        self.assertFalse(cli._provider_roster_missing({"providers": {"some-other-key": {"base_url": "x"}}}))

    def test_selfheal_repairs_an_aliased_install_that_has_no_roster(self) -> None:
        """The 1.4.2 upgrade path: aliases exist, ``models`` does not — heal it."""
        self.store.config["model_aliases"]["wb"] = {"model": "hy3", "provider": "workbuddy"}
        state = {"regions": {"cn": {"baseUrl": "http://127.0.0.1:8787/v1"},
                             "global": {"baseUrl": "http://127.0.0.1:8788/v1"}}}
        originals = (cli._read_token, cli._read_state, cli._fetch_models, cli._ALIAS_HEAL_AT[0])
        cli._ALIAS_HEAL_AT[0] = 0.0
        cli._read_token = lambda: "token"  # type: ignore[assignment]
        cli._read_state = lambda: state  # type: ignore[assignment]
        cli._fetch_models = (  # type: ignore[assignment]
            lambda url, token: ["hy3"] if "8787" in url else ["hy3", "glm-5.2"])
        try:
            cli._aliases_selfheal()
        finally:
            cli._read_token, cli._read_state, cli._fetch_models = originals[:3]
            cli._ALIAS_HEAL_AT[0] = originals[3]

        self.assertEqual(sorted(self.store.config["providers"]["workbuddy"]["models"]), ["hy3"])
        self.assertEqual(sorted(self.store.config["providers"]["workbuddy-global"]["models"]),
                         ["glm-5.2", "hy3"])


if __name__ == "__main__":
    unittest.main()
