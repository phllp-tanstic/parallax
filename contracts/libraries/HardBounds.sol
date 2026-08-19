// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Signer-independent hard bounds per docs/parallax_litepaper.md §9.8.
/// @dev CRITICAL: every check here must hold regardless of what the off-chain
///      risk-service signs. These are the contract's own enforcement, not a
///      courtesy check the service is trusted to have already done — §9.8 is
///      explicit that no off-chain component can override the guarantee.
///
///      Each function is deliberately isolated (not fused into one mega-check)
///      so §10.6's requirement — "fuzz test every hard bound in isolation" —
///      maps directly to one test function per bound, with no ambiguity about
///      which check failed.
library HardBounds {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MAX_CONCENTRATION_BPS = 6_000;   // 60% cap, §9.3/§9.8
    uint256 internal constant MAX_DELTA_BPS = 2_000;           // 20pp max move, §9.8
    uint256 internal constant MIN_LIQUIDITY_FLOOR_BPS = 1_000; // 10% USDC-equiv, §9.8

    error ExpiredAllocation(uint256 expiry, uint256 blockTimestamp);
    error InvalidNonce(uint256 expected, uint256 provided);
    error UnwhitelistedAsset(address asset);
    error ConcentrationCapExceeded(address asset, uint256 weightBps);
    error MaxDeltaExceeded(address asset, uint256 previousBps, uint256 newBps);
    error WeightsDoNotSumToOne(uint256 sumBps);
    error LiquidityFloorViolated(uint256 usdcEquivBps);
    error ArrayLengthMismatch(uint256 assetsLength, uint256 weightsLength);

    /// @dev §9.8: "Signed allocations include ... expiry timestamp."
    function checkNotExpired(uint256 expiry) internal view {
        if (block.timestamp > expiry) {
            revert ExpiredAllocation(expiry, block.timestamp);
        }
    }

    /// @dev §9.8: "nonce (replay protection)." Strictly increasing — no gaps
    ///      permitted is a deliberate design choice for simplicity; a gap-permitting
    ///      scheme (e.g. a bitmap of used nonces) is a valid alternative if the risk
    ///      service ever needs to submit out-of-order, but strictly-increasing is
    ///      simpler to reason about for MVP and matches "the same signal to persist"
    ///      framing in §7 step 5.
    function checkNonce(uint256 expectedNonce, uint256 providedNonce) internal pure {
        if (providedNonce != expectedNonce) {
            revert InvalidNonce(expectedNonce, providedNonce);
        }
    }

    /// @dev §9.8, §10.6: "confirm the contract's asset whitelist is hardcoded by
    ///      address, never resolved by ticker symbol at runtime" — this function
    ///      takes a pre-populated address=>bool mapping (the on-chain whitelist)
    ///      and checks membership directly; there is no symbol lookup anywhere in
    ///      this path, deliberately, per the lookalike-token lesson in §10.6.
    function checkWhitelisted(
        address asset,
        mapping(address => bool) storage whitelist
    ) internal view {
        if (!whitelist[asset]) {
            revert UnwhitelistedAsset(asset);
        }
    }

    /// @dev §9.3, §9.8: "no asset >60%, enforced independent of the QP's output."
    function checkConcentrationCap(address asset, uint256 weightBps) internal pure {
        if (weightBps > MAX_CONCENTRATION_BPS) {
            revert ConcentrationCapExceeded(asset, weightBps);
        }
    }

    /// @dev §9.8: "no single signed allocation may move any asset's weight by more
    ///      than 20 percentage points from the previous allocation."
    function checkMaxDelta(
        address asset,
        uint256 previousBps,
        uint256 newBps
    ) internal pure {
        uint256 delta = previousBps > newBps
            ? previousBps - newBps
            : newBps - previousBps;
        if (delta > MAX_DELTA_BPS) {
            revert MaxDeltaExceeded(asset, previousBps, newBps);
        }
    }

    /// @dev §9.3: weights must sum to exactly 10_000 bps (100%). No floating-point
    ///      tolerance needed on-chain since weights are integers by construction.
    function checkWeightsSumToOne(uint256[] memory weights) internal pure {
        uint256 sum;
        for (uint256 i = 0; i < weights.length; i++) {
            sum += weights[i];
        }
        if (sum != BPS_DENOMINATOR) {
            revert WeightsDoNotSumToOne(sum);
        }
    }

    /// @dev §9.8: "Minimum liquidity floor: >=10% USDC-equivalent at all times
    ///      (distinct from the crypto/equity diversification floor)." Caller
    ///      computes the post-allocation USDC-equivalent bps and passes it in —
    ///      this function only enforces the threshold, doesn't compute valuation
    ///      (valuation logic lives in RiskLegManager, kept separate from the
    ///      pure bound-checking here for testability).
    function checkLiquidityFloor(uint256 usdcEquivBps) internal pure {
        if (usdcEquivBps < MIN_LIQUIDITY_FLOOR_BPS) {
            revert LiquidityFloorViolated(usdcEquivBps);
        }
    }

    /// @dev Defensive check against a malformed signed allocation where assets[]
    ///      and weights[] have different lengths — would otherwise cause an
    ///      out-of-bounds read/silent truncation depending on how the caller
    ///      iterates. Not explicitly named in §9.8 but implied by "signed
    ///      allocations" being a coherent (asset, weight) pairing.
    function checkArrayLengthsMatch(
        uint256 assetsLength,
        uint256 weightsLength
    ) internal pure {
        if (assetsLength != weightsLength) {
            revert ArrayLengthMismatch(assetsLength, weightsLength);
        }
    }
}