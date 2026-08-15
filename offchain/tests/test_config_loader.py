"""Tests for risk_engine.config_loader (docs/parallax_litepaper.md §9.3).

Covers: loading the real committed asset_universe.yaml, malformed-file
rejection (missing keys, invalid class, duplicate ticker), and round-trip
compatibility with min_variance_weights().
"""

from pathlib import Path

import numpy as np
import pytest
import yaml

from risk_engine.config_loader import load_asset_universe, DEFAULT_CONFIG_PATH
from risk_engine.qp_solver import min_variance_weights


# ---------------------------------------------------------------------------
# Real committed config file
# ---------------------------------------------------------------------------

class TestRealConfigFile:
    def test_default_config_loads(self):
        asset_order, asset_classes = load_asset_universe()
        assert len(asset_order) > 0
        assert set(asset_order) == set(asset_classes.keys())

    def test_default_config_matches_mvp_universe(self):
        """§13: 2-3 xStocks + 1-2 crypto. Confirms the committed file matches
        the full MVP universe used elsewhere (BTC-USD, ETH-USD, wNVDAx,
        wTSLAx, wSPYx)."""
        asset_order, asset_classes = load_asset_universe()
        assert asset_order == ["BTC-USD", "ETH-USD", "wNVDAx", "wTSLAx", "wSPYx"]
        assert asset_classes["BTC-USD"] == "crypto"
        assert asset_classes["ETH-USD"] == "crypto"
        assert asset_classes["wNVDAx"] == "equity"
        assert asset_classes["wTSLAx"] == "equity"
        assert asset_classes["wSPYx"] == "equity"

    def test_class_counts_within_mvp_scope(self):
        """§13: 1-2 crypto assets, 2-3 equity assets."""
        _, asset_classes = load_asset_universe()
        crypto_count = sum(1 for c in asset_classes.values() if c == "crypto")
        equity_count = sum(1 for c in asset_classes.values() if c == "equity")
        assert 1 <= crypto_count <= 2
        assert 2 <= equity_count <= 3

    def test_default_path_points_to_config_directory(self):
        assert DEFAULT_CONFIG_PATH.name == "asset_universe.yaml"
        assert DEFAULT_CONFIG_PATH.parent.name == "config"

    def test_all_classes_are_valid(self):
        _, asset_classes = load_asset_universe()
        assert all(c in {"crypto", "equity"} for c in asset_classes.values())

    def test_no_duplicate_tickers(self):
        asset_order, _ = load_asset_universe()
        assert len(asset_order) == len(set(asset_order))


# ---------------------------------------------------------------------------
# Round-trip: loaded config feeds directly into min_variance_weights()
# ---------------------------------------------------------------------------

class TestRoundTripWithSolver:
    def test_loaded_universe_feeds_solver_successfully(self):
        """Confirms the config loader's output shape is directly consumable
        by min_variance_weights() with no adaptation — the actual integration
        point §9.3 describes."""
        asset_order, asset_classes = load_asset_universe()
        n = len(asset_order)
        cov = np.eye(n)
        w = min_variance_weights(cov, asset_order, asset_classes)
        assert w.shape == (n,)
        assert abs(w.sum() - 1.0) < 1e-5
        assert np.all(w >= -1e-5)


# ---------------------------------------------------------------------------
# Malformed file handling
# ---------------------------------------------------------------------------

class TestMalformedConfig:
    def test_missing_file_raises_file_not_found(self, tmp_path):
        missing = tmp_path / "does_not_exist.yaml"
        with pytest.raises(FileNotFoundError):
            load_asset_universe(missing)

    def test_missing_assets_key_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(yaml.dump({"not_assets": []}))
        with pytest.raises(ValueError, match="assets"):
            load_asset_universe(bad)

    def test_empty_assets_list_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(yaml.dump({"assets": []}))
        with pytest.raises(ValueError, match="non-empty"):
            load_asset_universe(bad)

    def test_entry_missing_ticker_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(yaml.dump({"assets": [{"class": "crypto"}]}))
        with pytest.raises(ValueError, match="ticker"):
            load_asset_universe(bad)

    def test_entry_missing_class_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(yaml.dump({"assets": [{"ticker": "BTC-USD"}]}))
        with pytest.raises(ValueError, match="class"):
            load_asset_universe(bad)

    def test_invalid_class_value_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            yaml.dump({"assets": [{"ticker": "BTC-USD", "class": "commodity"}]})
        )
        with pytest.raises(ValueError, match="Invalid class"):
            load_asset_universe(bad)

    def test_duplicate_ticker_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(
            yaml.dump(
                {
                    "assets": [
                        {"ticker": "BTC-USD", "class": "crypto"},
                        {"ticker": "BTC-USD", "class": "crypto"},
                    ]
                }
            )
        )
        with pytest.raises(ValueError, match="Duplicate ticker"):
            load_asset_universe(bad)

    def test_asset_entry_not_a_mapping_raises(self, tmp_path):
        bad = tmp_path / "bad.yaml"
        bad.write_text(yaml.dump({"assets": ["BTC-USD"]}))
        with pytest.raises(ValueError, match="expected a mapping"):
            load_asset_universe(bad)

    def test_contract_address_field_is_optional(self, tmp_path):
        """contract_address is not consumed by the loader's return shape —
        confirms a config entry lacking it entirely still loads fine (loader
        only cares about ticker/class; address verification is a separate
        on-chain concern, not this loader's job)."""
        ok = tmp_path / "ok.yaml"
        ok.write_text(
            yaml.dump({"assets": [{"ticker": "BTC-USD", "class": "crypto"}]})
        )
        asset_order, asset_classes = load_asset_universe(ok)
        assert asset_order == ["BTC-USD"]
        assert asset_classes == {"BTC-USD": "crypto"}