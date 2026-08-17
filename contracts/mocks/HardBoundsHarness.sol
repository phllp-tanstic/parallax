// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HardBounds} from "../libraries/HardBounds.sol";

/// @notice Test harness exposing HardBounds' internal library functions as
///         external calls, so each bound can be exercised and asserted on
///         directly from the Hardhat test suite (§10.1, §10.6 — "fuzz test
///         every hard bound in isolation").
/// @dev This contract has NO production role — it exists solely to make an
///      internal library testable. Do not deploy this alongside the real
///      protocol contracts.
contract HardBoundsHarness {
    mapping(address => bool) public whitelist;

    function setWhitelisted(address asset, bool isWhitelisted) external {
        whitelist[asset] = isWhitelisted;
    }

    function checkNotExpired(uint256 expiry) external view {
        HardBounds.checkNotExpired(expiry);
    }

    function checkNonce(uint256 expectedNonce, uint256 providedNonce) external pure {
        HardBounds.checkNonce(expectedNonce, providedNonce);
    }

    function checkWhitelisted(address asset) external view {
        HardBounds.checkWhitelisted(asset, whitelist);
    }

    function checkConcentrationCap(address asset, uint256 weightBps) external pure {
        HardBounds.checkConcentrationCap(asset, weightBps);
    }

    function checkMaxDelta(address asset, uint256 previousBps, uint256 newBps) external pure {
        HardBounds.checkMaxDelta(asset, previousBps, newBps);
    }

    function checkWeightsSumToOne(uint256[] memory weights) external pure {
        HardBounds.checkWeightsSumToOne(weights);
    }

    function checkLiquidityFloor(uint256 usdcEquivBps) external pure {
        HardBounds.checkLiquidityFloor(usdcEquivBps);
    }

    function checkArrayLengthsMatch(uint256 assetsLength, uint256 weightsLength) external pure {
        HardBounds.checkArrayLengthsMatch(assetsLength, weightsLength);
    }

    // Convenience getters so tests can assert against the library's own
    // constants rather than hardcoding duplicate magic numbers.
    function maxConcentrationBps() external pure returns (uint256) {
        return HardBounds.MAX_CONCENTRATION_BPS;
    }

    function maxDeltaBps() external pure returns (uint256) {
        return HardBounds.MAX_DELTA_BPS;
    }

    function minLiquidityFloorBps() external pure returns (uint256) {
        return HardBounds.MIN_LIQUIDITY_FLOOR_BPS;
    }

    function bpsDenominator() external pure returns (uint256) {
        return HardBounds.BPS_DENOMINATOR;
    }
}