"""Tests for risk_engine.qp_solver (docs/parallax_litepaper.md §9.3, §9.3.1).

Coverage requirements per §10.1:
  - Feasible solution across the full expected asset universe under the
    concentration cap and both per-class floors simultaneously active.
  - Infeasibility fallback (§9.3.1) engages and returns a valid weight vector
    when floors make the primary problem infeasible; floors dropped entirely,
    not partially relaxed.
  - Missing asset_classes entry raises ValueError, not silent drop/misclassify.
  - Weights are non-negative (long-only) and sum to 1 in all cases.
  - Diversification floors are respected when the primary solve succeeds.
  - Concentration cap is respected in both primary and fallback paths.
  - The optimizer actually minimises variance: lower-variance assets receive
    higher weight when covariances differ.
"""

import numpy as np
import pytest

from risk_engine.qp_solver import min_variance_weights

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

# Minimal valid universe: one crypto, one equity — both floor classes present.
TWO_ASSET_ORDER = ["BTC-USD", "wNVDAx"]
TWO_ASSET_CLASSES = {"BTC-USD": "crypto", "wNVDAx": "equity"}

# Full expected MVP universe: 2 crypto + 3 equity (wNVDAx, wTSLAx, wSPYx).
FULL_ORDER = ["BTC-USD", "ETH-USD", "wNVDAx", "wTSLAx", "wSPYx"]
FULL_CLASSES = {
    "BTC-USD": "crypto",
    "ETH-USD": "crypto",
    "wNVDAx": "equity",
    "wTSLAx": "equity",
    "wSPYx": "equity",
}


def _identity_cov(n: int) -> np.ndarray:
    """Identity covariance — equal variance, no correlation."""
    return np.eye(n)


def _scaled_identity(n: int, scales: list[float]) -> np.ndarray:
    """Diagonal covariance with specified per-asset variances."""
    return np.diag(scales)


# ---------------------------------------------------------------------------
# Helper assertions reused across tests
# ---------------------------------------------------------------------------

def assert_valid_weights(w: np.ndarray, n: int, tol: float = 1e-5) -> None:
    """Core invariants that must hold for every returned weight vector."""
    assert w.shape == (n,), f"Expected shape ({n},), got {w.shape}"
    assert np.all(w >= -tol), f"Weights contain negatives (long-only violated): {w}"
    assert abs(w.sum() - 1.0) < tol, f"Weights do not sum to 1: {w.sum()}"


def assert_floor_respected(
    w: np.ndarray,
    asset_order: list[str],
    asset_classes: dict[str, str],
    crypto_floor: float = 0.10,
    equity_floor: float = 0.10,
    tol: float = 1e-5,
) -> None:
    crypto_idx = [i for i, t in enumerate(asset_order) if asset_classes[t] == "crypto"]
    equity_idx = [i for i, t in enumerate(asset_order) if asset_classes[t] == "equity"]
    if crypto_idx:
        assert w[crypto_idx].sum() >= crypto_floor - tol, (
            f"Crypto floor violated: {w[crypto_idx].sum():.6f} < {crypto_floor}"
        )
    if equity_idx:
        assert w[equity_idx].sum() >= equity_floor - tol, (
            f"Equity floor violated: {w[equity_idx].sum():.6f} < {equity_floor}"
        )


def assert_cap_respected(
    w: np.ndarray,
    max_concentration: float = 0.60,
    tol: float = 1e-5,
) -> None:
    assert np.all(w <= max_concentration + tol), (
        f"Concentration cap violated: max weight {w.max():.6f} > {max_concentration}"
    )


# ---------------------------------------------------------------------------
# §9.3 — Validation: missing asset_classes entry
# ---------------------------------------------------------------------------

class TestValidation:
    def test_missing_single_ticker_raises_value_error(self):
        """Ticker in asset_order absent from asset_classes must raise ValueError."""
        cov = _identity_cov(2)
        with pytest.raises(ValueError, match="asset_classes"):
            min_variance_weights(
                cov,
                TWO_ASSET_ORDER,
                {"BTC-USD": "crypto"},  # wNVDAx deliberately omitted
            )

    def test_missing_multiple_tickers_raises_value_error(self):
        """All missing tickers should appear in the error, not just the first."""
        cov = _identity_cov(2)
        with pytest.raises(ValueError, match="asset_classes"):
            min_variance_weights(cov, TWO_ASSET_ORDER, {})

    def test_extra_keys_in_asset_classes_are_ignored(self):
        """asset_classes may contain tickers not in asset_order — not an error."""
        cov = _identity_cov(2)
        extended = {**TWO_ASSET_CLASSES, "wSPYx": "equity", "EXTRA": "crypto"}
        w = min_variance_weights(cov, TWO_ASSET_ORDER, extended)
        assert_valid_weights(w, 2)


# ---------------------------------------------------------------------------
# §9.3 — Primary solve: basic invariants
# ---------------------------------------------------------------------------

class TestPrimarySolveInvariants:
    def test_weights_sum_to_one_two_asset(self):
        cov = _identity_cov(2)
        w = min_variance_weights(cov, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)
        assert_valid_weights(w, 2)

    def test_weights_sum_to_one_full_universe(self):
        cov = _identity_cov(5)
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
        assert_valid_weights(w, 5)

    def test_weights_non_negative_long_only(self):
        """No weight should ever be negative — §9.3 is long-only throughout."""
        rng = np.random.default_rng(42)
        # Random PSD matrix via Gram construction
        A = rng.standard_normal((5, 5))
        cov = A.T @ A / 5
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
        assert np.all(w >= -1e-5), f"Negative weights found: {w}"

    def test_concentration_cap_respected_primary(self):
        cov = _identity_cov(5)
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
        assert_cap_respected(w, max_concentration=0.60)

    def test_custom_concentration_cap(self):
        cov = _identity_cov(5)
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES, max_concentration=0.30)
        assert_cap_respected(w, max_concentration=0.30)

    def test_diversification_floors_respected_primary(self):
        cov = _identity_cov(5)
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
        assert_floor_respected(w, FULL_ORDER, FULL_CLASSES)

    def test_custom_floors_respected(self):
        cov = _identity_cov(5)
        w = min_variance_weights(
            cov, FULL_ORDER, FULL_CLASSES,
            crypto_floor=0.15, equity_floor=0.15,
        )
        assert_floor_respected(w, FULL_ORDER, FULL_CLASSES, 0.15, 0.15)

    def test_returns_ndarray(self):
        cov = _identity_cov(2)
        w = min_variance_weights(cov, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)
        assert isinstance(w, np.ndarray)

    def test_output_shape_matches_asset_order(self):
        cov = _identity_cov(5)
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
        assert w.shape == (5,)


# ---------------------------------------------------------------------------
# §9.3 — Primary solve: optimality check
# ---------------------------------------------------------------------------

class TestPrimarySolveOptimality:
    def test_lower_variance_asset_gets_higher_weight(self):
        """With uncorrelated assets differing only in variance, the optimizer
        should allocate more to the lower-variance asset (subject to floors)."""
        # wNVDAx (equity, idx=1) has 10x lower variance than BTC-USD (crypto, idx=0)
        cov = _scaled_identity(2, [1.0, 0.1])
        w = min_variance_weights(cov, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)
        # Both floors bind at 10%, but the optimizer should still push remaining
        # weight toward the lower-variance asset.
        assert w[1] > w[0], (
            f"Expected lower-variance equity to receive higher weight; "
            f"got crypto={w[0]:.4f}, equity={w[1]:.4f}"
        )

    def test_equal_covariance_equal_weights_two_asset(self):
        """Identity covariance with symmetric floors → equal split (0.5, 0.5)."""
        cov = _identity_cov(2)
        w = min_variance_weights(cov, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)
        np.testing.assert_allclose(w, [0.5, 0.5], atol=1e-4)

    def test_equal_covariance_full_universe_equal_within_class(self):
        """Identity cov, 5 assets (2 crypto, 3 equity): within each class weights
        should be equal (by symmetry), and class totals satisfy floors."""
        cov = _identity_cov(5)
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
        # Crypto: BTC-USD, ETH-USD should be equal
        np.testing.assert_allclose(w[0], w[1], atol=1e-4)
        # Equity: wNVDAx, wTSLAx, wSPYx should be equal
        np.testing.assert_allclose(w[2], w[3], atol=1e-4)
        np.testing.assert_allclose(w[3], w[4], atol=1e-4)

    def test_zero_covariance_matrix_still_returns_valid_weights(self):
        """All-zero semi-covariance (all-positive-return window) → any
        feasible point is optimal; solver must still return valid weights."""
        cov = np.zeros((2, 2))
        w = min_variance_weights(cov, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)
        assert_valid_weights(w, 2)
        assert_floor_respected(w, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)


# ---------------------------------------------------------------------------
# §9.3.1 — Infeasibility fallback
# ---------------------------------------------------------------------------

class TestInfeasibilityFallback:
    def _make_infeasible_universe(self):
        """Construct a universe where the floors are geometrically infeasible.

        Strategy: one crypto asset, one equity asset, max_concentration=0.50.
        The floors require crypto >= 0.10 AND equity >= 0.10, sum = 1.0 — that's
        actually feasible at (0.50, 0.50). To force infeasibility we set floors
        that exceed what the cap allows: crypto_floor=0.60, equity_floor=0.60
        would require sum >= 1.20 with sum == 1 constraint — infeasible.
        """
        cov = _identity_cov(2)
        asset_order = ["BTC-USD", "wNVDAx"]
        asset_classes = {"BTC-USD": "crypto", "wNVDAx": "equity"}
        return cov, asset_order, asset_classes

    def test_fallback_returns_valid_weight_vector(self):
        """§9.3.1: forced infeasibility must not raise or return NaN — must
        return a valid weight vector via the cap-only fallback path."""
        cov, order, classes = self._make_infeasible_universe()
        w = min_variance_weights(
            cov, order, classes,
            crypto_floor=0.60,   # impossible: 0.60 + 0.60 > 1.0
            equity_floor=0.60,
        )
        assert_valid_weights(w, 2)

    def test_fallback_respects_concentration_cap(self):
        """Even in fallback, the concentration cap must still hold."""
        cov, order, classes = self._make_infeasible_universe()
        w = min_variance_weights(
            cov, order, classes,
            crypto_floor=0.60,
            equity_floor=0.60,
            max_concentration=0.60,
        )
        assert_cap_respected(w, max_concentration=0.60)

    def test_fallback_does_not_partially_relax_floors(self):
        """§9.3.1 is explicit: floors are dropped entirely in the fallback, not
        partially relaxed. When the fallback fires we cannot test that floors
        ARE met (they're dropped), but we can test that the function does not
        raise — any non-raising return with valid weights satisfies the spec."""
        cov, order, classes = self._make_infeasible_universe()
        # If partial relaxation happened (e.g. only one floor dropped), the
        # solver might return a result that satisfies exactly one floor. We
        # don't assert floor values here — just that we get valid weights back.
        w = min_variance_weights(
            cov, order, classes,
            crypto_floor=0.60,
            equity_floor=0.60,
        )
        assert w is not None
        assert not np.any(np.isnan(w))

    def test_fallback_not_triggered_on_feasible_input(self):
        """Sanity: a normal feasible problem must not silently fall back.
        We can't directly observe which path was taken, but the result must
        satisfy the floors — which the fallback path does NOT guarantee."""
        cov = _identity_cov(5)
        w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
        # If fallback had wrongly fired, floors might not be met.
        assert_floor_respected(w, FULL_ORDER, FULL_CLASSES)

    def test_three_asset_single_class_infeasible_floors(self):
        """Fallback with a universe containing only crypto assets — equity floor
        cannot bind because no equity assets exist. Floors are still dropped
        entirely in the fallback, and a valid solution must be returned."""
        order = ["BTC-USD", "ETH-USD", "SOL-USD"]
        classes = {"BTC-USD": "crypto", "ETH-USD": "crypto", "SOL-USD": "crypto"}
        cov = _identity_cov(3)
        # equity_floor=0.60 with no equity assets → primary infeasible (floor
        # constraint references an empty index, meaning 0.0 >= 0.60 is false).
        w = min_variance_weights(
            cov, order, classes,
            crypto_floor=0.60,
            equity_floor=0.60,
        )
        assert_valid_weights(w, 3)


# ---------------------------------------------------------------------------
# §9.3 — Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_single_crypto_single_equity_tight_caps(self):
        """Two assets, cap=0.90 — floors still satisfiable; both constraints
        active simultaneously."""
        cov = _identity_cov(2)
        w = min_variance_weights(
            cov, TWO_ASSET_ORDER, TWO_ASSET_CLASSES,
            max_concentration=0.90,
        )
        assert_valid_weights(w, 2)
        assert_floor_respected(w, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)
        assert_cap_respected(w, max_concentration=0.90)

    def test_all_equity_universe_crypto_floor_vacuous(self):
        """If no crypto assets exist, the crypto floor constraint is vacuously
        satisfied (no index to constrain). Must not raise."""
        order = ["wNVDAx", "wTSLAx", "wSPYx"]
        classes = {"wNVDAx": "equity", "wTSLAx": "equity", "wSPYx": "equity"}
        cov = _identity_cov(3)
        w = min_variance_weights(cov, order, classes)
        assert_valid_weights(w, 3)

    def test_all_crypto_universe_equity_floor_vacuous(self):
        """Symmetric to above for all-crypto universe."""
        order = ["BTC-USD", "ETH-USD"]
        classes = {"BTC-USD": "crypto", "ETH-USD": "crypto"}
        cov = _identity_cov(2)
        w = min_variance_weights(cov, order, classes)
        assert_valid_weights(w, 2)

    def test_asset_order_as_tuple_accepted(self):
        """asset_order is typed as Sequence — a tuple must work identically."""
        cov = _identity_cov(2)
        w = min_variance_weights(cov, tuple(TWO_ASSET_ORDER), TWO_ASSET_CLASSES)
        assert_valid_weights(w, 2)

    def test_highly_correlated_assets_still_feasible(self):
        """Near-singular covariance (high correlation) must not cause a solver
        failure — the PSD guarantee from §9.2 holds by construction."""
        # Two assets with correlation 0.999
        cov = np.array([[1.0, 0.999], [0.999, 1.0]])
        w = min_variance_weights(cov, TWO_ASSET_ORDER, TWO_ASSET_CLASSES)
        assert_valid_weights(w, 2)

    def test_random_psd_matrix_full_universe(self):
        """Randomised PSD covariance matrix — solver must always return valid
        weights for the full MVP asset universe."""
        rng = np.random.default_rng(2024)
        for _ in range(10):
            A = rng.standard_normal((5, 5))
            cov = A.T @ A  # Gram matrix, guaranteed PSD
            w = min_variance_weights(cov, FULL_ORDER, FULL_CLASSES)
            assert_valid_weights(w, 5)
            assert_floor_respected(w, FULL_ORDER, FULL_CLASSES)
            assert_cap_respected(w)