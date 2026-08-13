"""Downside semi-covariance estimation.

Implements the Estrada-style semi-covariance estimator specified in
docs/parallax_litepaper.md §9.2.
"""

import numpy as np


def semi_covariance_matrix(
    window_returns: np.ndarray,
    target: float = 0.0,
) -> np.ndarray:
    """Estimate the downside semi-covariance matrix over a return window.

    Per docs/parallax_litepaper.md §9.2, returns are first clipped to their
    downside deviations relative to ``target``::

        downside = min(window_returns - target, 0)

    and the estimator is the scaled Gram matrix of those deviations::

        Sigma = downside.T @ downside / T

    where ``T`` is the number of observations in the window.

    The result is guaranteed positive semi-definite by construction, with no
    eigenvalue repair or shrinkage step required. Because ``Sigma`` is a Gram
    matrix scaled by ``1 / T``, for any weight vector ``x``::

        x.T @ Sigma @ x == norm(downside @ x) ** 2 / T >= 0

    i.e. every quadratic form is a scaled squared norm and therefore
    non-negative. This matters downstream: the mean-variance program in §9.3
    minimizes ``w.T @ Sigma @ w``, and a PSD ``Sigma`` is what makes that
    objective convex and the QP solvable to a global optimum.

    Args:
        window_returns: Periodic returns, shape ``(T, N)`` for ``T``
            observations across ``N`` assets. Column order defines the asset
            order of the returned matrix.
        target: Return threshold below which deviations count as downside.
            Defaults to ``0.0``, making the estimator penalize outright losses
            only.

    Returns:
        Semi-covariance matrix of shape ``(N, N)``, symmetric and PSD, in the
        same asset order as the columns of ``window_returns``.

        Expressed in the same periodicity as ``window_returns`` — the raw
        estimator, not annualized. Scaling to an annual basis is the caller's
        responsibility, so that this function stays a single, testable
        definition of the §9.2 estimator.
    """
    if window_returns.shape[0] == 0:
        raise ValueError(
            "semi_covariance_matrix requires at least one observation; "
            "got empty window_returns"
        )

    downside = np.minimum(window_returns - target, 0.0)
    n_observations = window_returns.shape[0]
    result = downside.T @ downside / n_observations

    # NOTE: downside @ downside.T (wrong transposition) also produces a
    # symmetric PSD matrix and would pass the assertion below when T==N.
    # The shape check in Test 4 of test_semi_covariance.py is the primary
    # guard against that transposition bug.
    assert np.allclose(result, result.T, atol=1e-10), (
        "semi-covariance matrix must be symmetric"
    )

    return result