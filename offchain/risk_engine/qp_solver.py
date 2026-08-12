"""Minimum-variance portfolio solver.

Implements the constrained quadratic program specified in
docs/parallax_litepaper.md §9.3, with the infeasibility fallback from §9.3.1.
"""

from typing import Sequence

import numpy as np


def min_variance_weights(
    cov_matrix: np.ndarray,
    asset_order: Sequence[str],
    asset_classes: dict[str, str],
    max_concentration: float = 0.60,
    crypto_floor: float = 0.10,
    equity_floor: float = 0.10,
) -> np.ndarray:
    """Solve for minimum-variance portfolio weights under allocation limits.

    Per docs/parallax_litepaper.md §9.3, this solves the quadratic program::

        minimize    w.T @ cov_matrix @ w
        subject to  sum(w) == 1
                    0 <= w_i <= max_concentration      for all i
                    sum(w over crypto assets) >= crypto_floor
                    sum(w over equity assets) >= equity_floor

    The objective is convex whenever ``cov_matrix`` is positive semi-definite,
    which the §9.2 semi-covariance estimator guarantees by construction, so the
    solution is a global optimum.

    **The model is long-only.** The ``0 <= w_i`` bound is not an incidental
    detail of this solver: §9.3 assumes long-only throughout, and no shorting
    mechanism exists anywhere in the Parallax design. Weights are never
    negative.

    **Asset-class membership is caller-supplied, never inferred.** ``asset_classes``
    is passed in by the caller and sourced from configuration (e.g.
    ``offchain/config/asset_universe.yaml`` or equivalent); it must **never** be
    hardcoded inside this risk-engine module. This keeps the solver reusable and
    testable independently of which specific assets are currently in the
    universe. §9.3 notes that the research backtest which produced the published
    §9.4 numbers used module-level ``CRYPTO_TICKERS``/``EQUITY_TICKERS``
    constants; that was acceptable for a fixed-universe research script and is
    explicitly **not** the production pattern. The underlying math — the QP, the
    floor values, the validated results — is unchanged; only the mechanism for
    supplying class membership has been formalized.

    **Every ticker in ``asset_order`` must have a matching entry in
    ``asset_classes``.** If any ticker is missing a class mapping, this function
    must raise a clear validation error — it must not silently default the
    asset to a class, drop it from the universe, or otherwise misclassify it.

    §9.3.1 requires an infeasibility fallback: the constraint set can be empty
    for some inputs — for example when the per-class floors plus the
    concentration cap cannot be satisfied simultaneously given the assets
    actually present in ``asset_order``. When the floored problem is infeasible,
    the fallback is the unconstrained solve retaining only the concentration
    cap: **the floors are dropped entirely, not partially relaxed.** This
    function must not propagate a solver failure or return ``NaN`` weights in
    that case; it is required to detect infeasibility, engage the fallback, and
    return a valid, non-null weight vector rather than leaving the caller
    without a portfolio.

    Args:
        cov_matrix: Positive semi-definite covariance or semi-covariance
            matrix, shape ``(N, N)``, ordered to match ``asset_order``.
        asset_order: Asset identifiers for each row/column of ``cov_matrix``,
            length ``N``. Determines the order of the returned weights.
        asset_classes: Mapping of ticker to asset class, e.g.
            ``{"BTC-USD": "crypto", "wNVDAx": "equity"}``. Supplied by the
            caller from configuration, never hardcoded in this module. Supplies
            the class membership used by the per-class floor constraints. Must
            contain an entry for every ticker in ``asset_order``.
        max_concentration: Upper bound on any single asset's weight. Defaults
            to ``0.60``.
        crypto_floor: Minimum combined weight across crypto-class assets.
            Defaults to ``0.10``.
        equity_floor: Minimum combined weight across equity-class assets.
            Defaults to ``0.10``.

    Returns:
        Weight vector of shape ``(N,)``, non-negative (long-only) and summing
        to 1, in the same order as ``asset_order``.

    Raises:
        ValueError: If any ticker in ``asset_order`` has no corresponding entry
            in ``asset_classes``.
    """
    raise NotImplementedError("see docs/parallax_litepaper.md §9.3")
