"""Safe-leg / risk-leg principal-protection sizing.

Implements the safe-leg sizing formula specified in
docs/parallax_litepaper.md §9.1.
"""


def safe_leg_split(principal: float, r: float, t: float) -> tuple[float, float]:
    """Split a deposit into safe-leg and risk-leg amounts per §9.1.

    Per docs/parallax_litepaper.md §9.1::

        safe_leg = principal / (1 + r)^t
        risk_leg = principal - safe_leg

    ``safe_leg`` is the amount that, compounded at rate ``r`` for term ``t``,
    exactly regrows to ``principal`` — this is the mathematical basis of the
    principal-protection guarantee. The remainder is the ``risk_leg``,
    allocated per §9.3.

    **MVP note (§9.1, §9.8):** ``r`` here is expected to be the conservative,
    contract-enforced flat-rate minimum — never a value more aggressive than
    that floor, regardless of what an off-chain AI forecast proposes. This
    function does not itself enforce that signer-independent bound (§9.8 is a
    contract-level invariant); it computes the split for whatever ``r`` it is
    given. Callers on the AI-forecast path (post-MVP, currently unbuilt) are
    responsible for clamping ``r`` to the conservative floor before calling
    this function, or for relying on the contract's hard bound as the final
    backstop.

    Worked example (§9.1, 365-day term, 8% illustrative APY):
    ``principal=10_000, r=0.08, t=1`` → ``safe_leg≈9259.26, risk_leg≈740.74``
    (risk leg ≈ 7.41% of principal).

    Args:
        principal: Deposit amount. Must be non-negative.
        r: Conservative Aave APY estimate, as a decimal (e.g. ``0.08`` for
            8%). Must be non-negative — Aave lending rates are not modeled as
            negative in this system.
        t: Term length as a fraction of a year (e.g. ``1.0`` for the MVP's
            single 365-day term, per §13). Must be non-negative.

    Returns:
        ``(safe_leg, risk_leg)`` tuple. Both non-negative; they sum to
        exactly ``principal``.

    Raises:
        ValueError: If ``principal``, ``r``, or ``t`` is negative.
    """
    if principal < 0:
        raise ValueError(f"principal must be non-negative, got {principal}")
    if r < 0:
        raise ValueError(f"r must be non-negative, got {r}")
    if t < 0:
        raise ValueError(f"t must be non-negative, got {t}")

    safe_leg = principal / ((1 + r) ** t)
    risk_leg = principal - safe_leg

    return safe_leg, risk_leg