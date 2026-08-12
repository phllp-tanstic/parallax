"""Tests for risk_engine.qp_solver (docs/parallax_litepaper.md §9.3, §9.3.1).

Stub only — no assertions on solver output yet, because
``min_variance_weights()`` is itself still a stub that raises
``NotImplementedError``. Every call below uses the amended §9.3 signature, so
these placeholders fail on the missing implementation, never on a signature
mismatch.
"""

import numpy as np
import pytest

from risk_engine.qp_solver import min_variance_weights

# Minimal valid universe: one crypto asset and one equity asset, so both §9.3
# per-class floors have at least one asset to bind against. Class membership is
# caller-supplied here exactly as §9.3 requires — the solver never infers it.
ASSET_ORDER = ["BTC-USD", "wNVDAx"]
ASSET_CLASSES = {"BTC-USD": "crypto", "wNVDAx": "equity"}
COV_MATRIX = np.eye(len(ASSET_ORDER))


def test_signature_accepts_caller_supplied_asset_classes():
    """The §9.3 signature is callable with ``asset_classes`` third.

    Guards the stub state: reaching ``NotImplementedError`` proves the call
    bound successfully, i.e. no ``TypeError`` from a stale two-positional-arg
    form. Replace this with real coverage once the solver is implemented.
    """
    with pytest.raises(NotImplementedError):
        min_variance_weights(COV_MATRIX, ASSET_ORDER, ASSET_CLASSES)


@pytest.mark.skip(reason="min_variance_weights() not implemented — §9.3")
def test_returns_feasible_weights_under_cap_and_floors():
    # TODO: §9.3 — feasible solution across the full expected asset universe
    # with the concentration cap and both per-class floors active at once;
    # weights non-negative (long-only) and summing to 1.
    min_variance_weights(COV_MATRIX, ASSET_ORDER, ASSET_CLASSES)


@pytest.mark.skip(reason="min_variance_weights() not implemented — §9.3.1")
def test_infeasible_problem_drops_floors_entirely():
    # TODO: §9.3.1 — forced-infeasibility case must engage the fallback and
    # return a valid, non-null weight vector, with the floors dropped entirely
    # rather than partially relaxed. Must never silently fail.
    min_variance_weights(COV_MATRIX, ASSET_ORDER, ASSET_CLASSES)


@pytest.mark.skip(reason="min_variance_weights() not implemented — §9.3")
def test_ticker_missing_from_asset_classes_raises():
    # TODO: §9.3 — a ticker present in asset_order but absent from
    # asset_classes must raise a validation error, not be silently dropped or
    # misclassified. Expect ValueError once implemented. The mapping below
    # deliberately omits "wNVDAx" to set up that case.
    min_variance_weights(COV_MATRIX, ASSET_ORDER, {"BTC-USD": "crypto"})
