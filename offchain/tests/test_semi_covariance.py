"""Tests for risk_engine.semi_covariance (docs/parallax_litepaper.md §9.2).

Covers the two §9.2 test requirements (PSD across randomized return series,
all-zero matrix when no return falls below target) plus the §10.3 symmetry
invariant and the shape contract the §9.3 solver depends on.

Every random case is seeded, so a failure is reproducible from the test id
alone rather than only on an unlucky run.
"""

import numpy as np
import pytest

from risk_engine.semi_covariance import semi_covariance_matrix

# §9.2 clips at target=0.0, so the PSD/symmetry properties are exercised
# against the default the production caller actually uses.
TARGET = 0.0

# Loosest tolerance the §10.3 PSD invariant allows: eigenvalues of a Gram
# matrix are non-negative in exact arithmetic, so anything below this is
# float error in the eigensolver, not a genuinely indefinite matrix.
PSD_ATOL = -1e-10


@pytest.mark.parametrize("seed", range(50))
def test_matrix_is_psd_across_randomized_windows(seed):
    """§9.2 / §10.3: eigenvalues are non-negative for every randomized window.

    Fifty independent cases sweeping T in [10, 100] and N in [2, 8]. Uses
    ``eigvalsh`` because the input is symmetric by construction, which keeps
    the returned eigenvalues real rather than complex-with-zero-imaginary.
    """
    rng = np.random.default_rng(seed)
    n_observations = int(rng.integers(10, 101))
    n_assets = int(rng.integers(2, 9))

    # Scaled to a plausible daily-return magnitude, centered on zero so each
    # window contains a mix of upside and downside days.
    window_returns = rng.normal(loc=0.0, scale=0.02, size=(n_observations, n_assets))

    result = semi_covariance_matrix(window_returns, TARGET)
    eigenvalues = np.linalg.eigvalsh(result)

    assert np.all(eigenvalues >= PSD_ATOL), (
        f"negative eigenvalue for T={n_observations}, N={n_assets}: "
        f"min={eigenvalues.min():.3e}"
    )


def test_all_positive_returns_produce_zero_matrix():
    """§9.2 / §10.3: a window with zero negative days yields an all-zero matrix.

    With every return strictly above target, ``min(r - target, 0)`` is
    identically zero, so the Gram product is exactly zero — not merely small.
    Tolerance is 1e-15 because this is an exact-zero claim, not an estimate.
    """
    rng = np.random.default_rng(101)

    # Strictly positive: uniform on (0, 0.05] shifted clear of zero so no
    # sampled value can land at or below the target.
    window_returns = rng.uniform(low=0.001, high=0.05, size=(30, 4))
    assert np.all(window_returns > TARGET), "fixture must contain no downside days"

    result = semi_covariance_matrix(window_returns, TARGET)

    assert np.allclose(result, np.zeros((4, 4)), atol=1e-15)


def test_matrix_is_symmetric():
    """§10.3 symmetry invariant on a window with mixed-sign returns."""
    rng = np.random.default_rng(202)
    window_returns = rng.normal(loc=0.0, scale=0.03, size=(40, 5))

    # Guard the fixture: symmetry is only a meaningful test when the downside
    # mask is partially populated, i.e. the matrix is not trivially zero.
    assert np.any(window_returns < TARGET), "fixture must contain downside days"
    assert np.any(window_returns > TARGET), "fixture must contain upside days"

    result = semi_covariance_matrix(window_returns, TARGET)

    assert np.allclose(result, result.T, atol=1e-10)


def test_output_shape_is_n_by_n():
    """Shape contract: (T, N) in, (N, N) out — never (T, T).

    This is what catches a ``downside @ downside.T`` transposition bug, which
    the PSD and symmetry checks cannot: the wrong product is symmetric and PSD
    too, just the wrong size.
    """
    rng = np.random.default_rng(303)
    window_returns = rng.normal(loc=0.0, scale=0.02, size=(25, 3))

    result = semi_covariance_matrix(window_returns, TARGET)

    assert result.shape == (3, 3)


def test_single_asset_equals_mean_squared_downside_deviation():
    """N=1 edge case: the 1x1 entry is the mean squared downside deviation.

    The expected value is accumulated in an explicit Python loop rather than
    with vectorized numpy, so it is an independent reference computation and
    not a restatement of the implementation. Note the divisor is T (every
    observation), not the count of negative days — §9.2 scales by 1/T.
    """
    rng = np.random.default_rng(404)
    n_observations = 20
    window_returns = rng.normal(loc=0.0, scale=0.02, size=(n_observations, 1))
    assert np.any(window_returns < TARGET), "fixture must contain downside days"

    total = 0.0
    for observation in window_returns[:, 0]:
        deviation = observation - TARGET
        if deviation < 0.0:
            total += deviation**2
    expected = total / n_observations

    result = semi_covariance_matrix(window_returns, TARGET)

    assert result.shape == (1, 1)
    assert result[0, 0] == pytest.approx(expected, abs=1e-15)

def test_empty_window_raises_value_error():
    """T=0 input must raise ValueError, not return nan silently (§9.2 guard)."""
    empty = np.zeros((0, 3))
    with pytest.raises(ValueError, match="empty"):
        semi_covariance_matrix(empty)
