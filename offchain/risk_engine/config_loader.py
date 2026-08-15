"""Asset-universe configuration loader.

Loads the asset universe from ``offchain/config/asset_universe.yaml`` (or an
equivalent config file) into the ``asset_order`` / ``asset_classes`` shapes
expected by ``risk_engine.qp_solver.min_variance_weights()``.

Per docs/parallax_litepaper.md §9.3: "asset_classes is supplied by the
caller, sourced from configuration ... never hardcoded inside the risk-engine
module itself." This module is that configuration boundary — the QP solver
itself imports nothing from here and has no knowledge of this file's
existence, by design.
"""

from pathlib import Path
from typing import Any

import yaml

VALID_CLASSES = {"crypto", "equity"}

DEFAULT_CONFIG_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "asset_universe.yaml"
)


def load_asset_universe(
    path: str | Path = DEFAULT_CONFIG_PATH,
) -> tuple[list[str], dict[str, str]]:
    """Load asset order and class mapping from a YAML config file.

    Args:
        path: Path to the asset universe YAML file. Defaults to
            ``offchain/config/asset_universe.yaml`` relative to this module.

    Returns:
        A ``(asset_order, asset_classes)`` tuple:
          - ``asset_order``: list of tickers in the order they appear in the
            config file. Callers should treat this as the canonical ordering
            for ``cov_matrix`` rows/columns and the returned weight vector.
          - ``asset_classes``: dict mapping ticker -> class ("crypto" or
            "equity"), directly consumable by
            ``risk_engine.qp_solver.min_variance_weights()``.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
        ValueError: If the file is malformed (missing top-level ``assets``
            key, an entry missing ``ticker``/``class``, a duplicate ticker,
            or a ``class`` value outside ``{"crypto", "equity"}``).
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Asset universe config not found: {path}")

    with open(path, "r") as f:
        raw: Any = yaml.safe_load(f)

    if not isinstance(raw, dict) or "assets" not in raw:
        raise ValueError(
            f"Malformed asset universe config at {path}: "
            "expected a top-level 'assets' key."
        )

    entries = raw["assets"]
    if not isinstance(entries, list) or not entries:
        raise ValueError(
            f"Malformed asset universe config at {path}: "
            "'assets' must be a non-empty list."
        )

    asset_order: list[str] = []
    asset_classes: dict[str, str] = {}

    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(
                f"Malformed entry at assets[{i}] in {path}: expected a mapping, "
                f"got {type(entry).__name__}."
            )

        ticker = entry.get("ticker")
        asset_class = entry.get("class")

        if not ticker or not isinstance(ticker, str):
            raise ValueError(
                f"Malformed entry at assets[{i}] in {path}: missing or invalid "
                "'ticker'."
            )
        if not asset_class or not isinstance(asset_class, str):
            raise ValueError(
                f"Malformed entry for ticker '{ticker}' in {path}: missing or "
                "invalid 'class'."
            )
        if asset_class not in VALID_CLASSES:
            raise ValueError(
                f"Invalid class '{asset_class}' for ticker '{ticker}' in {path}: "
                f"must be one of {sorted(VALID_CLASSES)}."
            )
        if ticker in asset_classes:
            raise ValueError(
                f"Duplicate ticker '{ticker}' in {path} — each ticker must "
                "appear exactly once."
            )

        asset_order.append(ticker)
        asset_classes[ticker] = asset_class

    return asset_order, asset_classes