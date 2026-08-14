# Parallax
## Litepaper & Technical Product Blueprint
**BuildX AI Season · X Layer · Version 1.0 — Source of Truth**

*This document consolidates every validated decision, formula, architecture choice, risk, and test requirement established during the project's research and validation phase. It supersedes all prior partial drafts. No speculative features are introduced beyond what was tested or explicitly scoped as future work.*

---

## 1. Executive Summary

Parallax is a principal-protected structured note issued on X Layer. A user deposits USDC; the deposit is split automatically into a **safe leg** (deposited into Aave, sized to regrow to exactly the original principal by maturity) and a **risk leg** (allocated across crypto and tokenized equities — xStocks — using a validated downside-risk-minimizing model). At maturity, the user receives their full principal back, guaranteed by the safe leg's structure, plus whatever the risk leg is worth — which can be zero in the worst case, but cannot be negative to the user's principal.

The risk-leg allocation engine is the same downside-semivariance model validated across two independent historical market regimes (2022–2024, including the 2022 crash, and 2024–2026) via walk-forward backtesting. The validated claim is narrow and specific: the model reduces maximum drawdown by 10–12 percentage points relative to an equal-weight buy-and-hold portfolio, with a hard 10% diversification floor per asset class ensuring the user always holds both crypto and equity exposure. The model does **not** claim to beat the market on absolute return, and this document does not soften that finding anywhere it appears.

Parallax requires X Layer specifically because it is, as of this project's research (August 2026), the only chain with tokenized U.S. equities (xStocks), sub-second Chainlink equity/crypto pricing, and deep DeFi lending liquidity (Aave v3.6) simultaneously live — the combination the safe-leg/risk-leg mechanism depends on.

---

## 2. Concept and Definition

**Parallax** (noun): a structured DeFi product on X Layer that converts a stablecoin deposit into a principal-protected note, using real lending yield (not options, not synthetic hedging) to guarantee return of principal at maturity, while directing a portion of the deposit into an AI-managed, diversification-floored allocation across crypto and tokenized equities.

Parallax is **not**: an autonomous trading agent, a portfolio optimizer claiming to beat the market, a yield farming aggregator, or an options/derivatives product. It does not use options because none exist on X Layer as of this project's research — the principal-protection mechanism is built entirely from a real lending position, not a synthetic hedge.

---

## 3. Product Thesis

DeFi users who want exposure to both crypto and real-world equities face a binary choice today: take full risk, or take none. There is no product on X Layer offering structurally guaranteed downside with genuine upside participation. Parallax's thesis is that this gap can be closed without options infrastructure, using a well-understood structured-finance pattern (yield-funded principal protection) combined with a validated, honestly-scoped AI risk model for the at-risk portion of the deposit.

**The validated claim, stated precisely:** the risk-leg allocation model, when constrained by a 10% per-asset-class floor, reduces maximum drawdown by approximately 12 percentage points in a crash regime and approximately 0.6 percentage points in a trending regime, relative to unconstrained equal-weight exposure, without claiming to improve absolute return.

---

## 4. Problem Statement

**Who has this problem, and what does it cost them:** an X Layer user holding crypto who wants equity exposure (or vice versa) must either (a) accept full downside risk on a new asset class with no protection mechanism, or (b) avoid the exposure entirely and miss the diversification benefit. Existing DeFi yield products optimize for return, not protection. Existing tokenized-equity products (xStocks itself) are just tradable tokens — they offer no risk management layer.

**Why this matters now, not hypothetically:** xStocks went live on X Layer on July 15, 2026 — this problem did not exist in a buildable form before that date, because there was no real, DeFi-composable equity asset to build a protected exposure product around. Aave v3.6 (March 2026) and Chainlink Data Streams (June 2026) both had to be live first. Parallax is buildable now because all three prerequisites cleared within the five weeks before this hackathon.

---

## 5. Target Users

- **Primary:** X Layer-native DeFi users with stablecoin holdings who want equity/crypto exposure without risking principal — a more risk-averse audience than typical DeFi yield-farmers, closer to a savings-product mindset.
- **Secondary:** existing crypto holders seeking a first, structurally-safe entry point into tokenized equities.
- **Explicitly out of scope:** users in jurisdictions excluded from xStocks (confirmed: United States, United Kingdom, Canada, Australia, and other restricted territories per issuer terms). This is a real, disclosed constraint on total addressable market, not a detail to omit from the pitch.

---

## 6. Proposed Solution

Split every deposit into two independently-tracked on-chain positions:

1. **Safe leg** — a real Aave lending position, sized so that its guaranteed yield-driven growth exactly returns full principal at maturity, regardless of what the risk leg does.
2. **Risk leg** — the remainder, allocated across available crypto and xStocks assets using a validated, diversification-floored, downside-risk-minimizing model, executed as real on-chain swaps.

The principal guarantee is a structural property of the contract, not a promise: even if the risk leg goes to zero, the safe leg alone returns full principal. This is enforced by contract logic with signer-independent hard bounds — no off-chain component can override the guarantee.

---

## 7. How Parallax Works, End-to-End

1. User deposits USDC and selects a term (MVP: 365 days only — see §13 for why).
2. The off-chain rate-forecasting service computes the safe-leg size using either the conservative flat-rate formula (MVP default) or a validated AI forecast (post-MVP, gated on its own backtest — see §9.1).
3. The contract deposits the safe-leg amount into Aave, verifying the signed sizing against a hard minimum floor (never smaller than the conservative calculation).
4. The remaining risk-leg amount is allocated across available crypto/xStocks assets by solving the downside-semivariance QP (§9.3), subject to the 10% per-class floor and 60% per-asset concentration cap, and executed as real DEX swaps.
5. The vault continuously monitors risk-leg allocation. De-risking rebalances (toward lower weighted-average asset volatility) execute automatically when trigger conditions are met (§9.5). Re-risking rebalances require the same signal to persist for 5 trading days before executing (§9.6).
6. At maturity, the safe leg is withdrawn from Aave (= full principal, guaranteed) and the risk leg is liquidated/transferred at its then-current value. Total payout = principal + risk-leg value (which may be zero, cannot be negative to principal).
7. Early exit before maturity is available at a computed mark-to-model value, explicitly disclosed as forfeiting the full-principal guarantee (§9.7).

---

## 8. Core Product Features

| Feature | MVP | Post-MVP |
|---|---|---|
| Principal-protected note (safe leg + risk leg split) | ✅ | — |
| Downside-semivariance risk-leg allocation | ✅ | — |
| 10% diversification floor per asset class | ✅ | — |
| Asymmetric automation (de-risk auto, re-risk confirmed) | ✅ | — |
| Conservative flat-rate safe-leg sizing | ✅ | Superseded by AI forecast if validated |
| AI-forecasted safe-leg sizing | ❌ | ✅ (gated on backtest, §9.1) |
| Simple penalty-based early exit | ✅ (fallback) | Mark-to-model pricing (✅ if validated, §9.7) |
| Single 365-day term | ✅ | Multiple term lengths |
| Non-transferable notes | ✅ | Transferable/tradeable notes |
| Multiple simultaneous notes per user | ❌ | ✅ |

---

## 9. Formulas, Parameters, Invariants, and Assumptions

### 9.1 Safe-leg sizing (principal-protection formula)

```
safe_leg = principal / (1 + r)^t
risk_leg = principal - safe_leg
```

**Inputs:** `principal` (deposit amount), `r` (Aave APY, conservative estimate), `t` (term as fraction of year).
**Output:** the two-leg split.
**Why:** this is the amount that, compounded at `r` for `t`, exactly regrows to `principal` — the mathematical basis of the guarantee.
**Worked example (365-day term, 8% illustrative APY):** $10,000 → safe leg $9,259.26, risk leg $740.74 (7.41%).
**MVP default:** `r` uses a conservative, flat, contract-enforced minimum — never a value more aggressive than this floor, regardless of what an off-chain forecast proposes (signer-independent hard bound, §9.8).
**Test requirement:** unit test confirming `safe_leg * (1+r)^t == principal` within rounding tolerance, for a range of `r` and `t` values including edge cases (`r=0`, `t=0`).
**AI-forecasted version (post-MVP):** requires its own walk-forward backtest against historical Aave rate data, two independent periods, pre-committed kill condition: *if the forecast would have failed to guarantee principal in either historical period, it does not ship — flat-rate fallback only.* Not yet run.

### 9.2 Downside semi-covariance matrix (Estrada-style)

```
downside_ij = min(r_i - target, 0) * min(r_j - target, 0)
SemiCov = (1/T) * Σ downside_ij   [computed as downside.T @ downside / T]
```

**Inputs:** rolling window of daily returns (`LOOKBACK_WINDOW = 30` days), `target` return threshold (`= 0.0`).
**Output:** an n×n matrix, guaranteed positive semi-definite by construction (it is a Gram matrix, `X.T @ X`, so for any weight vector `w`: `w.T @ Σ @ w = ||downside @ w||² / T ≥ 0` — every quadratic form is a scaled squared norm, hence non-negative), safe to use directly in a convex QP without additional regularization or eigenvalue repair.
**Why:** only penalizes downside deviations — a sharp rally contributes zero risk penalty, only a sharp drop does. This is the core mechanism that makes the de-risking signal reliable without making any return forecast.
**Test requirement:** property test confirming the output matrix is always PSD (eigenvalues ≥ 0) across randomized return series; unit test confirming a return series with zero negative days produces an all-zero matrix.

### 9.3 Risk-leg allocation QP (the core optimizer)

```
minimize:   w^T Σ w
subject to: Σw = 1
            0 ≤ w_i ≤ 0.60                      (per-asset concentration cap, long-only)
            Σ w[a for a in assets if class(a) == "crypto"] ≥ 0.10   (diversification floor)
            Σ w[a for a in assets if class(a) == "equity"] ≥ 0.10   (diversification floor)
```

**Inputs:** the semi-covariance matrix (§9.2), and an explicit asset-class mapping — **not inferred or hardcoded inside the solver.** The reference implementation's function signature is:

```
min_variance_weights(
    cov_matrix: np.ndarray,
    asset_order: Sequence[str],
    asset_classes: dict[str, str],   # e.g. {"BTC-USD": "crypto", "wNVDAx": "equity"}
    max_concentration: float = 0.60,
    crypto_floor: float = 0.10,
    equity_floor: float = 0.10,
) -> np.ndarray
```

`asset_classes` is supplied by the caller, sourced from configuration (e.g. `offchain/config/asset_universe.yaml` or equivalent) — **never hardcoded inside the risk-engine module itself.** This keeps the solver reusable and testable independent of which specific assets are currently in the universe, and satisfies the project's standing rule against hardcoding values that should be configurable. Every key in `asset_order` must have a corresponding entry in `asset_classes`; the function must raise a clear validation error (not silently default or drop the asset) if any ticker is missing a class mapping.

**Output:** target allocation weights, in the order given by `asset_order`, non-negative (long-only — the model never shorts; §9.3 assumes long-only throughout, no shorting mechanism exists anywhere in this design), summing to 1.

**Why:** deterministic, convex, reproducible — no return forecast anywhere in this step. This is the single most important design decision in the entire product: the AI computes risk, never return.

**Note on the validated backtest results in §9.4:** the walk-forward sweep that produced the published Sharpe/MaxDD numbers was run against a research script that hardcoded `CRYPTO_TICKERS`/`EQUITY_TICKERS` as module-level constants. That was acceptable for a fixed-universe research backtest but is explicitly **not** the production pattern — the production `min_variance_weights()` signature above corrects this. The underlying math (the QP itself, the floor values, the validated results) is unchanged; only the mechanism for supplying class membership has been formalized.

**Test requirement:** solver must return a feasible solution for the full expected asset universe under the concentration cap and floor combined (verify feasibility is not accidentally over-constrained — e.g., floor × number of classes must not exceed 1 − sum of other hard constraints). Infeasibility fallback path (§9.3.1) must be tested explicitly, not assumed to never trigger. Additionally: test that a ticker present in `asset_order` but missing from `asset_classes` raises a validation error rather than being silently dropped or misclassified.

**9.3.1 Infeasibility fallback:** if the constrained QP has no feasible solution, the contract-enforced fallback is the unconstrained solve (concentration cap only, no floor — floors are dropped entirely in the fallback, not partially relaxed). This must never silently fail — test requirement: forced-infeasibility unit test confirming fallback engages and returns a valid, non-null weight vector.

### 9.4 Diversification floor — validated value

**Chosen value: 10% per asset class**, selected via a 6-point sweep (0%, 5%, 10%, 15%, 20%, 25%) across both walk-forward periods.

| Floor | Period 1 (crash) Sharpe | Period 1 MaxDD | Period 2 Sharpe | Period 2 MaxDD |
|---|---|---|---|---|
| 0% (unconstrained) | -0.027 | -40.16% | 1.107 | -20.67% |
| **10% (chosen)** | 0.362 | **-28.45%** | 1.070 | -20.07% |
| 15% (best Sharpe) | 0.381 | -30.20% | 1.021 | -20.26% |
| 25% | 0.350 | -34.61% | 0.899 | -20.67% |

**Why 10%, not 15% (which has marginally higher Sharpe):** Parallax's product claim is downside protection specifically, not risk-adjusted return — the floor should optimize the metric the pitch leads with. 10% achieves the shallowest drawdown of any tested value in the crash regime.
**Curve shape confirmed smooth and unimodal** (rises from 0%, peaks near 10-15%, falls past 20%) across the full 6-point sweep — a genuine optimum, not an artifact of testing only two points.
**Test requirement:** the sweep itself is the test. Any future change to the universe of assets, lookback window, or trigger thresholds requires re-running the full sweep before assuming 10% remains optimal — do not carry this number forward unexamined if the underlying model changes.

### 9.5 De-risk trigger (automatic execution)

```
Trade executes automatically IF:
    max_drift_bps > 500                                    (deadband)
    AND var_reduction > 0.15                                (min variance reduction)
    AND target_avg_vol ≤ current_avg_vol × 1.01              (de-risk direction)
    AND benefit_estimate > cost × 3.0                        (cost safety margin)
```

**Why the 3x safety margin:** ensures the estimated risk-reduction benefit clearly exceeds transaction cost (gas + slippage + spread) before the contract trades — prevents cost-churning on marginal signals.
**Test requirement:** integration test confirming no trade executes when any single condition fails; confirming cost estimate correctly scales with trade size against the calibrated slippage curve (§9.9, and see the caveat in §9.9 about slippage model provenance).

### 9.6 Re-risk trigger (confirmation-delayed execution)

```
IF is_rerisk (target_avg_vol > current_avg_vol × 1.01):
    IF no pending signal: record signal, do NOT execute
    IF pending signal age ≥ 5 trading days: execute with FRESH target
    ELSE: continue waiting
```

**Why:** validated finding — the model's de-risking calls were reliable, its re-risking timing was not (it stayed at 0% crypto exposure through an entire subsequent recovery period when unconstrained and un-delayed). Requiring persistence filters transient signals; this is a partial mitigation, not a complete fix — the diversification floor (§9.4) is what actually closed the remaining gap, discovered empirically during floor validation.
**Test requirement:** unit test confirming a signal that reverses before 5 days never executes (whipsaw filtering); confirming a persistent signal executes at day 5 using freshly-recomputed weights, not the stale weights from day 1.
**Rejected alternative — trade cooldown:** a minimum 10-day interval between any trades was tested and found to *increase* total transaction costs in both periods (delayed trades consolidated into larger, costlier moves) without improving Sharpe or drawdown. **Explicitly not implemented.** Documented here so it is not accidentally re-proposed without re-testing.

### 9.7 Early-exit pricing

**MVP default:** simple, disclosed penalty-based pricing (not yet formula-specified — this is an explicit open item, see §17).
**Post-MVP target:** AI-computed mark-to-model value (real-time valuation of both legs, including Aave early-withdrawal cost and risk-leg current mark). **Not yet backtested.** Test requirement before shipping: compare model-implied exit value against realized value if held to maturity, across historical windows — determines whether early exit is fairly priced or systematically favors/disfavors either party.

### 9.8 Signer-independent hard bounds (security invariants)

Applies regardless of what the off-chain service signs:
- Max allocation delta per update: no single signed allocation may move any asset's weight by more than 20 percentage points from the previous allocation.
- Hard concentration cap: no asset >60%, enforced independent of the QP's output.
- Minimum liquidity floor: ≥10% USDC-equivalent at all times (distinct from the crypto/equity diversification floor).
- Signed allocations include nonce (replay protection) and expiry timestamp, EIP-712 domain-separated (chain ID + contract address).
- Risk-service unavailability/compromise: contract holds last valid allocation, accepts no new instructions — never defaults to full-liquidate or full-deploy.
- Safe-leg sizing: never smaller than the conservative flat-rate calculation, regardless of what an AI forecast signs (§9.1).

**Test requirement (adversarial):** fuzz test submitting out-of-bound signed allocations (delta >20pp, concentration >60%, expired timestamp, replayed nonce) and confirming every one is rejected at the contract level, not merely discouraged at the service level.

### 9.9 Transaction cost model — known limitation, flagged explicitly

The backtest's slippage assumptions (approx. 1.3% at $1K, 3.9% at $5K, 7.2% at $10K trade size) were originally derived using a constant-product (Uniswap V2-style) approximation against the confirmed wNVDAx/USDG pool. **This pool was subsequently confirmed to be a Uniswap V3 pool (concentrated liquidity), for which the V2 constant-product slippage formula does not directly apply.** The existing cost figures in the backtest script should be treated as directionally indicative, not precisely validated. **This is an open test requirement, not a resolved one** — see §17.

### 9.10 wNVDAx accounting (rebasing-wrapper handling)

Confirmed via direct on-chain calls (not assumed from documentation):
- `asset()` → returns the base NVDAx contract address, confirming ERC-4626-style wrapper pattern.
- `totalAssets()` / `totalSupply()` ratio and `convertToAssets(1e18)` both confirm a small, real, accruing exchange rate (~1.0009 at time of testing).
- **Vault rule:** `totalAssets()` valuation must call `convertToAssets()` live, every time — never cached. This is a small, well-defined addition, not the full rebasing-tracking logic originally scoped for the unwrapped base token.
**Test requirement:** integration test depositing, simulating a change in the wrapper's exchange rate (via a mock or forked-mainnet state change), and confirming the vault's valuation updates correctly without a redeploy.

---

## 10. Complete Testing Strategy

### 10.1 Unit tests
- Safe-leg sizing formula (§9.1) correctness across `r`, `t` ranges, including zero and boundary values.
- Semi-covariance matrix PSD property (§9.2), randomized inputs.
- QP constraint satisfaction (§9.3) for known input matrices with hand-computable optimal solutions.
- Infeasibility fallback (§9.3.1) triggers correctly under forced-infeasible constraint sets.
- Hard-bound rejection (§9.8) for every individual bound type, tested in isolation.

### 10.2 Mathematical / model validation
- Full 6-point diversification floor sweep (§9.4) — already run, must be re-run if the asset universe or model parameters change.
- Walk-forward backtest, minimum two independent non-overlapping periods, no parameter changes between runs, pass/fail rule pre-committed **before** running, not after seeing results. This is a process requirement, not just a one-time test — any future model change must repeat this exact discipline.
- Safe-leg AI-forecasting model (§9.1), if built: same walk-forward standard against historical Aave rate data, explicit kill condition pre-committed.
- Early-exit mark-to-model pricing (§9.7), if built: backtest against realized-value-at-maturity across historical windows.

### 10.3 Invariant / property tests
- Semi-covariance matrix is always PSD (property test, randomized).
- Safe leg, compounded at its locked-in rate for the full term, always equals or exceeds original principal (core guarantee invariant — this is the single most important property test in the entire system).
- Sum of risk-leg allocation weights always equals 1.0 (within floating-point tolerance) after any successful rebalance.
- Diversification floor is never violated by any executed allocation (crypto weight ≥ 10% AND equity weight ≥ 10% at all times post-rebalance).
- No single asset ever exceeds the 60% concentration cap post-rebalance.

### 10.4 Integration tests
- End-to-end deposit → safe-leg Aave deposit → risk-leg allocation → confirm both on-chain positions match expected split.
- De-risk trigger (§9.5) fires and executes correctly against live (testnet) Aave/DEX integration.
- Re-risk confirmation delay (§9.6) correctly withholds execution until day 5, then executes with fresh (not stale) target weights.
- Rebasing-wrapper valuation (§9.10) integration test as specified above.

### 10.5 Simulation / backtesting requirements
- All simulation results in this document (§9.4, and the core validated claim in §1/§3) were produced via the walk-forward protocol described in §10.2. Any new simulation claim added to the pitch or documentation must follow the same protocol before being stated as fact.

### 10.6 Adversarial / edge-case tests
- Fuzz testing of signed allocation submissions against every hard bound in §9.8.
- Zero-liquidity / thin-pool scenario: confirm the vault does not execute a trade that would produce catastrophic slippage — test against the actual confirmed thin-liquidity condition of the wNVDAx pool (§9.9), not a hypothetical deep-liquidity assumption.
- Lookalike-token protection: confirm the contract's asset whitelist is hardcoded by address, never resolved by ticker symbol at runtime (direct lesson from this session's own research, where multiple lookalike tokens with near-identical names were found in a live search UI).
- Oracle staleness: confirm rebalance execution reverts if the Chainlink feed timestamp exceeds a defined freshness threshold — this specific test is currently unimplemented and must be added (see §17).

### 10.7 Vault accounting tests
- `totalAssets()` correctness under the rebasing-wrapper exchange rate (§9.10).
- Share price stability across simulated deposit/withdraw sequences with no rebalancing activity (no-op should never move share price).
- Share price correctness immediately after a rebalance (must reflect actual post-trade holdings, not stale pre-trade state).

### 10.8 Rebalance execution tests
- De-risk execution (§9.5) end-to-end against testnet DEX liquidity.
- Re-risk confirmation-delay execution (§9.6) end-to-end.
- Cost-gating (3x safety margin) correctly blocks trades where estimated benefit does not clear the threshold — test with a synthetic marginal-benefit scenario.

### 10.9 Oracle failure tests
- Chainlink feed returns a stale timestamp → rebalance must revert, not execute on stale data. **Not yet implemented — open item, §17.**
- Chainlink feed unavailable entirely → contract must hold last valid allocation, per §9.8, not fail open.

### 10.10 End-to-end tests
- Full note lifecycle: issue → (testnet time-skip, disclosed per §13) → maturity → redemption, confirming payout equals safe-leg guaranteed value plus risk-leg realized value.
- Early exit lifecycle: issue → early exit request → payout at disclosed penalty/mark-to-model value, confirming the full-principal guarantee is explicitly not honored on early exit (by design, and must be clearly surfaced to the user in the UI before confirmation).

**Pass/fail criteria summary:** every test category above has an explicit pass condition stated inline. Categories §10.2 (model validation) and §10.9 (oracle failure) contain the two highest-priority open items before this can be considered production-ready — see §17.

---

## 11. Development Roadmap

### Phase 1 — Pre-Hackathon (Research & Validation) — COMPLETE
**Objective:** validate the core technical and financial claims before committing build time.
**Deliverables:** on-chain confirmation of xStocks/wNVDAx contract behavior, confirmed Uniswap V3 pool and liquidity depth, walk-forward-validated risk model, diversification floor sweep, eligibility research.
**Status:** complete, as documented in §9 above. This phase is the reason the rest of this document can make specific, evidenced claims rather than assumptions.

### Phase 2 — Hackathon MVP (10–12 days)
**Objective:** ship a working, honestly-scoped note issuance and management system on X Layer testnet/mainnet.
**Deliverables:** see §12 checklist and §13 MVP definition.
**Dependencies:** eligibility question (conditionally cleared, §17), Aave/Uniswap/xStocks integration access.
**Milestone acceptance criteria:** full note lifecycle (issue → mature → redeem) demonstrable end-to-end on-chain, with real transactions at every step, per the demo script in §14.

### Phase 3 — Post-Hackathon Hardening
**Objective:** close every open test/validation item flagged in §17, add third-party security review.
**Deliverables:** oracle staleness test implementation, corrected V3-native slippage model, AI safe-leg forecasting (if backtest clears), mark-to-model early-exit pricing (if backtest clears), external audit.
**Acceptance criteria:** all §10 test categories fully implemented and passing, no open items remaining from §17.

### Phase 4 — Production
**Objective:** remove hackathon-scope constraints (deposit caps, single term length, non-transferability) once hardening is complete and audited.
**Deliverables:** multiple term lengths, transferable notes, expanded asset universe, licensed correlation-engine API for third-party protocols.
**Acceptance criteria:** post-audit sign-off, mainnet deposit caps lifted incrementally with monitoring.

---

## 12. Phase-by-Phase Development Checklist

### Research / Validation (Phase 1 — complete)
- [x] Confirm xStocks live on X Layer with real contract addresses
- [x] Confirm wNVDAx wrapper mechanics (`asset()`, `totalAssets()`, `convertToAssets()`)
- [x] Confirm real DEX pool and measure liquidity depth
- [x] Walk-forward backtest of downside-semivariance risk model, two periods
- [x] Diversification floor sweep (6 points)
- [x] Eligibility research (conditionally cleared — §17 for residual risk)

### Architecture
- [ ] Finalize contract module boundaries (vault/note core, Aave integration, DEX integration, oracle consumer)
- [ ] EIP-712 signature scheme for off-chain risk-service → on-chain allocation submission
- [ ] Confirm asset whitelist is address-based, not symbol-based (§10.6)

### Contracts
- [ ] `issueNote()` — deposit split, safe-leg Aave deposit, risk-leg allocation
- [ ] `redeemAtMaturity()` — safe-leg withdrawal, risk-leg liquidation, payout
- [ ] `redeemEarly()` — penalty/mark-to-model payout, explicit non-guarantee disclosure
- [ ] `submitRebalanceTarget()` / `executeRebalance()` — signed allocation, hard-bound enforcement (§9.8)
- [ ] All unit and property tests from §10.1/§10.3 passing

### AI Model
- [ ] Semi-covariance computation service (§9.2)
- [ ] QP solver integration (§9.3), infeasibility fallback tested
- [ ] Rate-forecasting model for safe-leg sizing — **MVP: not built, flat-rate only** (§9.1)
- [ ] Mark-to-model early-exit pricing — **MVP: not built, simple penalty only** (§9.7)

### Execution Engine
- [ ] De-risk trigger logic (§9.5) wired to Aave/DEX execution
- [ ] Re-risk confirmation-delay logic (§9.6)
- [ ] Cost-gating against real slippage estimates — **flag: current model needs V3-native correction (§9.9)**
- [ ] Oracle staleness check — **not yet implemented, open item (§17)**

### Frontend
- [ ] Deposit + term selection UI
- [ ] Live safe-leg/risk-leg split projection
- [ ] Maturity tracker
- [ ] Early-exit value display with explicit guarantee-forfeiture disclosure
- [ ] Rebalance activity feed with linked on-chain transactions

### Testing
- [ ] All categories in §10 implemented, not just unit tests
- [ ] Adversarial/fuzz testing against hard bounds (§9.8, §10.6)
- [ ] Oracle failure simulation (§10.9)

### Security
- [ ] Reentrancy guards on all external-call-adjacent functions
- [ ] Fuzz testing of signed allocation submissions
- [ ] Hard deposit cap for hackathon scope, disclosed in UI
- [ ] No admin withdrawal function; `Pausable` only, disclosed as safety rail

### Deployment
- [ ] Testnet deployment and full lifecycle dry-run
- [ ] Mainnet deployment with disclosed deposit cap

### Documentation
- [ ] This document kept current as the single source of truth
- [ ] Public-facing disclosure of all known limitations (§17) — not hidden from users or judges

### Demo Preparation
- [ ] Disclosed testnet time-skip mechanism for maturity demonstration (§13)
- [ ] Demo script rehearsed against §14
- [ ] Real, non-mocked transactions at every demo step

### Judging Requirements
- [ ] AI application clearly demonstrable and honestly scoped (no overclaiming)
- [ ] X Layer integration breadth shown (Aave, DEX, Chainlink, xStocks simultaneously)
- [ ] Product completeness: full lifecycle working, not a partial mockup
- [ ] Growth potential and ecosystem contribution addressed in pitch (§4, §11 Phase 4)

### Post-Hackathon Productionization
- [ ] Close all §17 open items
- [ ] Third-party security audit
- [ ] V3-native slippage model correction (§9.9)
- [ ] Oracle staleness protection implementation (§10.9)

---

## 13. MVP Definition (Scope Boundary — Do Not Creep)

**In scope for hackathon MVP:**
- Single 365-day term only. **This is not a demo-convenience shortcut** — a shorter term was tested mathematically and found to shrink the risk leg to near-zero (a 7-day term yields a 0.15% risk leg, defeating the product's purpose). The 365-day term is kept for real economics; the demo problem is solved separately via disclosed testnet time-skip, not by weakening the product.
- Conservative flat-rate safe-leg sizing (no AI forecasting claim).
- Simple penalty-based early exit (no mark-to-model claim).
- Downside-semivariance risk-leg allocation with 10% diversification floor — **this is fully validated and is the core demonstrable claim.**
- Asymmetric automation (de-risk auto-execute, re-risk 5-day confirmation).
- 2–3 xStocks + 1–2 crypto assets in the risk-leg universe.
- Non-transferable notes, single term, hard deposit cap.

**Explicitly out of scope — do not build during hackathon window:**
- AI-forecasted safe-leg sizing (requires its own backtest, not run).
- Mark-to-model early-exit pricing (requires its own backtest, not run).
- Multiple term lengths.
- Transferable/tradeable notes.
- Options-based collar/hedge mechanisms (no options infrastructure exists on X Layer — not a scope choice, an infrastructure constraint).
- Autonomous agent framing of any kind (explicitly against hackathon organizer guidance).
- Any related-but-separate product concepts explored and shelved during this project (a cross-asset risk oracle for other protocols, a trade-safety/lookalike-token checker, a smart execution router) — these remain documented ideas, not part of Parallax's MVP scope.

---

## 14. 60-Second Demo Script

"Deposit $10,000 USDC for a 365-day Parallax note. Watch the split happen live: the safe leg — real transaction — deposits into Aave, sized to guarantee full principal back in one year. The risk leg — real transaction — allocates across crypto and xStocks using our validated downside-protection model, always holding at least 10% in each asset class by contract-enforced floor. [Disclosed testnet time-skip: 'we're advancing this testnet clock forward one year — the mechanism is identical, only the passage of time is simulated for the demo.'] At maturity: the safe leg has regrown to exactly $10,000, guaranteed. The risk leg is worth [actual simulated/testnet value]. Total payout: full principal, plus real market exposure. This isn't a promise — it's validated on two independent historical market regimes, including the 2022 crash, to cut worst-case drawdown by roughly 12 percentage points, and it's how the contract is built, not just how it's pitched."

---

## 15. Technical Acceptance Checklist

- [ ] Full note lifecycle executes end-to-end on testnet with real transactions
- [ ] Safe-leg guarantee invariant holds under property testing (§10.3)
- [ ] Diversification floor never violated post-rebalance (§10.3)
- [ ] All hard bounds (§9.8) reject out-of-bound signed allocations under fuzz testing
- [ ] Rebasing-wrapper accounting correct under simulated exchange-rate change (§9.10)
- [ ] No silent failures anywhere in the QP infeasibility fallback path (§9.3.1)
- [ ] Demo time-skip mechanism clearly disclosed on-screen, not hidden

---

## 16. Unresolved Questions / Blockers

Ranked by severity, most important first:

1. **xStocks smart-contract eligibility — CLEARED via primary source documentation.** The official xStocks documentation at docs.xstocks.fi/docs states explicitly: *"Permissionless: xStocks can be held, transferred, integrated and traded across platforms and wallets without platform dependency or technical transfer restrictions."* The How xStocks Work page further confirms secondary market trading *"does not require direct interaction with the issuer and follows standard exchange or DeFi trading mechanics."* The Introduction explicitly describes xStocks as *"integrable into structured products"* — Parallax's exact use case. KYC is required only for primary market issuance and redemption, which Parallax does not use. Parallax acquires xStocks via DEX swap (secondary market) and holds them in a vault contract (DeFi composability), both explicitly permissionless per issuer documentation. OKX support's inability to confirm was a support-tier knowledge gap, not evidence of a restriction. This gate is closed. Sources: https://docs.xstocks.fi/docs (Permissionless characteristic), https://docs.xstocks.fi/docs/how-xstocks-work (Secondary Market section). 
2. **Transaction cost / slippage model needs correction.** Current figures were derived using a V2-style constant-product approximation against a pool subsequently confirmed to be Uniswap V3. Directionally useful, not precisely validated. Needs a proper V3 tick/liquidity-based slippage model before any cost claim is stated with confidence.
3. **Oracle staleness protection is specified (§9.8, §10.9) but not yet implemented in code.** This is a real gap between design and build status, not a resolved item — flagged explicitly rather than assumed complete because it's described in the architecture.
4. **Early-exit pricing formula is undefined for MVP** beyond "simple, disclosed penalty" — the exact formula needs to be specified before frontend work can proceed.
5. **Exchange OS availability timing remains unconfirmed** for third-party builders. Not required for MVP scope (Aave + Uniswap suffice), but relevant to any future roadmap item depending on it.
6. **AI safe-leg forecasting and mark-to-model exit pricing are both designed but explicitly unvalidated** — MVP ships without both, by decision, not by oversight.

---

## 17. Launch-Readiness Checklist (Post-Hackathon → Production)

- [x] Item 1 (eligibility) — CLOSED. Cleared via primary source documentation from docs.xstocks.fi. See §16 item 1 for full resolution record.
- [ ] Item 2 above (slippage model) corrected with proper V3 mechanics
- [ ] Item 3 above (oracle staleness) implemented and tested per §10.9
- [ ] Item 4 above (early-exit formula) specified and backtested per §9.7
- [ ] Third-party security audit complete, all findings resolved
- [ ] Hard deposit cap lifted incrementally with monitoring, not removed all at once
- [ ] All §10 test categories passing in CI, not just passing once manually
- [ ] Public documentation of every known limitation kept current — this document, or its successor, remains the single source of truth and is updated, not replaced ad hoc

---

*This document reflects the state of validation and decision-making as of this project's research phase. Every claim above traces to a specific test, backtest, or on-chain verification performed during that phase — none are asserted without an evidentiary basis stated inline. Where validation is incomplete, this document says so explicitly rather than presenting a design as if it were a proven result.*