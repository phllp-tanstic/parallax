"""Tests for risk_engine.safe_leg (docs/parallax_litepaper.md §9.1).

Test requirement per §9.1: unit test confirming
``safe_leg * (1+r)^t == principal`` within rounding tolerance, for a range
of ``r`` and ``t`` values including edge cases (``r=0``, ``t=0``).
"""

import numpy as np
import pytest

from risk_engine.safe_leg import safe_leg_split


# ---------------------------------------------------------------------------
# §9.1 — Validation
# ---------------------------------------------------------------------------

class TestValidation:
    def test_negative_principal_raises(self):
        with pytest.raises(ValueError, match="principal"):
            safe_leg_split(-100.0, 0.08, 1.0)

    def test_negative_rate_raises(self):
        with pytest.raises(ValueError, match="r must be"):
            safe_leg_split(10_000.0, -0.01, 1.0)

    def test_negative_term_raises(self):
        with pytest.raises(ValueError, match="t must be"):
            safe_leg_split(10_000.0, 0.08, -0.5)

    def test_zero_principal_is_valid(self):
        safe, risk = safe_leg_split(0.0, 0.08, 1.0)
        assert safe == 0.0
        assert risk == 0.0


# ---------------------------------------------------------------------------
# §9.1 — Core guarantee invariant: safe_leg * (1+r)^t == principal
# ---------------------------------------------------------------------------

class TestCoreInvariant:
    """This is the single most important property in §9.1 — the
    principal-protection guarantee reduces to this equation holding."""

    @pytest.mark.parametrize("principal", [1.0, 100.0, 10_000.0, 1_000_000.0])
    @pytest.mark.parametrize("r", [0.0, 0.01, 0.05, 0.08, 0.15, 0.50])
    @pytest.mark.parametrize("t", [0.0, 0.1, 0.5, 1.0, 2.0])
    def test_safe_leg_regrows_to_principal(self, principal, r, t):
        safe, _ = safe_leg_split(principal, r, t)
        regrown = safe * (1 + r) ** t
        assert regrown == pytest.approx(principal, rel=1e-9, abs=1e-9)

    def test_legs_sum_to_principal(self):
        """safe_leg + risk_leg must always equal principal exactly (within
        floating-point tolerance) — no value can leak or be fabricated."""
        for principal in (100.0, 10_000.0, 987_654.321):
            for r in (0.0, 0.03, 0.08, 0.25):
                for t in (0.0, 0.5, 1.0, 3.0):
                    safe, risk = safe_leg_split(principal, r, t)
                    assert safe + risk == pytest.approx(principal, rel=1e-9, abs=1e-9)


# ---------------------------------------------------------------------------
# §9.1 — Edge cases explicitly named in the litepaper
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_r_zero_safe_leg_equals_principal(self):
        """r=0 → no yield generated → safe_leg must equal the full principal,
        risk_leg must be zero (there is nothing to risk without yield)."""
        safe, risk = safe_leg_split(10_000.0, 0.0, 1.0)
        assert safe == pytest.approx(10_000.0)
        assert risk == pytest.approx(0.0)

    def test_t_zero_safe_leg_equals_principal(self):
        """t=0 → (1+r)^0 == 1 → safe_leg must equal the full principal,
        risk_leg must be zero (no time for yield to accrue)."""
        safe, risk = safe_leg_split(10_000.0, 0.08, 0.0)
        assert safe == pytest.approx(10_000.0)
        assert risk == pytest.approx(0.0)

    def test_r_zero_and_t_zero_together(self):
        safe, risk = safe_leg_split(10_000.0, 0.0, 0.0)
        assert safe == pytest.approx(10_000.0)
        assert risk == pytest.approx(0.0)

    def test_both_legs_non_negative(self):
        """risk_leg must never go negative — principal - safe_leg is only
        negative if safe_leg > principal, which cannot happen since
        (1+r)^t >= 1 for r,t >= 0."""
        for r in (0.0, 0.01, 0.08, 1.0, 5.0):
            for t in (0.0, 0.01, 1.0, 10.0):
                safe, risk = safe_leg_split(10_000.0, r, t)
                assert safe >= 0.0
                assert risk >= -1e-9  # floating-point floor


# ---------------------------------------------------------------------------
# §9.1 — Worked example from the litepaper
# ---------------------------------------------------------------------------

class TestWorkedExample:
    def test_10k_8pct_365day_matches_litepaper(self):
        """§9.1 worked example: $10,000 → safe leg $9,259.26,
        risk leg $740.74 (7.41%)."""
        safe, risk = safe_leg_split(10_000.0, 0.08, 1.0)
        assert safe == pytest.approx(9_259.26, abs=0.01)
        assert risk == pytest.approx(740.74, abs=0.01)
        assert risk / 10_000.0 == pytest.approx(0.0741, abs=0.0001)


# ---------------------------------------------------------------------------
# §9.1 — Property test: monotonicity sanity checks
# ---------------------------------------------------------------------------

class TestMonotonicity:
    def test_higher_rate_shrinks_safe_leg(self):
        """Higher r → safe_leg needs less capital to regrow to principal →
        smaller safe_leg, larger risk_leg."""
        safe_low, risk_low = safe_leg_split(10_000.0, 0.02, 1.0)
        safe_high, risk_high = safe_leg_split(10_000.0, 0.10, 1.0)
        assert safe_high < safe_low
        assert risk_high > risk_low

    def test_longer_term_shrinks_safe_leg(self):
        """Longer t → more time to compound → smaller safe_leg required,
        larger risk_leg available."""
        safe_short, risk_short = safe_leg_split(10_000.0, 0.08, 0.5)
        safe_long, risk_long = safe_leg_split(10_000.0, 0.08, 2.0)
        assert safe_long < safe_short
        assert risk_long > risk_short

    def test_risk_leg_scales_linearly_with_principal(self):
        """Fixed r, t → risk_leg fraction of principal must be constant
        regardless of principal size (the split is proportional)."""
        _, risk_small = safe_leg_split(100.0, 0.08, 1.0)
        _, risk_large = safe_leg_split(1_000_000.0, 0.08, 1.0)
        assert risk_large / 1_000_000.0 == pytest.approx(risk_small / 100.0, rel=1e-9)


# ---------------------------------------------------------------------------
# §13 — MVP-specific: single 365-day term (t=1.0) sanity check
# ---------------------------------------------------------------------------

class TestMVPTermSanity:
    def test_short_term_shrinks_risk_leg_toward_zero(self):
        """§13: a 7-day term was tested and found to yield a 0.15% risk leg,
        the cited reason the 365-day term was kept for real economics.
        Confirm the same qualitative behavior holds here as a regression
        guard on the underlying formula."""
        t_7day = 7 / 365
        _, risk = safe_leg_split(10_000.0, 0.08, t_7day)
        risk_pct = risk / 10_000.0
        # Litepaper cites ~0.15% for a 7-day term at (implicitly) similar r.
        assert risk_pct < 0.01, (
            f"Expected short-term risk leg to be near-negligible, got {risk_pct:.4%}"
        )

    def test_365day_term_produces_meaningful_risk_leg(self):
        """Confirms the 365-day MVP term (§13) produces a non-trivial risk
        leg, the stated rationale for keeping the term at one year."""
        _, risk = safe_leg_split(10_000.0, 0.08, 1.0)
        assert risk / 10_000.0 > 0.05  # meaningfully above a rounding artifact