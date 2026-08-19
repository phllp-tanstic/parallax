// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUniswapV3Router} from "./MockUniswapV3Router.sol";
import {RiskLegManager} from "../RiskLegManager.sol";
import {AllocationSigning} from "../libraries/AllocationSigning.sol";

/// @notice Adversarial router that attempts to reenter
///         RiskLegManager.submitRebalanceTarget from inside its own
///         exactInputSingle, per docs/parallax_litepaper.md §10.6's
///         adversarial-testing requirement and §12's reentrancy-guard item.
///
/// @dev WHY THIS ATTACK IS THE RIGHT ONE TO MODEL: submitRebalanceTarget is
///      permissionless — security rests on signature verification plus the §9.8
///      hard bounds, not on who calls it. So an attacker needs no privileged
///      access to be the caller, only a valid signed allocation, which becomes
///      public the moment it is submitted. Combined with a rebalance that hands
///      control to a DEX router mid-sequence, that is a real reentrancy surface
///      rather than a theoretical one: the sell and buy passes re-read
///      `balanceOf` and re-derive dollar targets BETWEEN swaps, so a reentrant
///      submission would act on half-rebalanced balances while the outer call's
///      remaining passes then execute against state the inner call already
///      moved. Each §9.8 bound could pass in isolation while the combined effect
///      breached them.
///
///      THIS IS A GENUINE ATTEMPT, not a mock that cannot reach the target:
///        - it holds a real RiskLegManager reference, not an interface stub;
///        - it holds a real EIP-712 signature over a real second allocation,
///          signed by the same riskServiceSigner the contract trusts, at the
///          nonce that is actually live at the moment of reentry (the outer call
///          increments `allocationNonce` BEFORE it swaps, so the armed
///          allocation uses that incremented value — the reentrant call would
///          clear the nonce check if it got that far);
///        - it calls submitRebalanceTarget directly, with NO try/catch, so a
///          revert propagates verbatim to the test rather than being swallowed
///          and reported second-hand.
///
///      When disarmed it behaves exactly like MockUniswapV3Router, which is what
///      lets a test prove the armed rejection is caused by reentrancy and not by
///      a malformed allocation: the same armed allocation, submitted normally
///      through this same router, succeeds.
contract MaliciousUniswapV3Router is MockUniswapV3Router {
    RiskLegManager public target;
    bool public attackEnabled;
    bool public attackAttempted;

    address[] private _attackAssets;
    uint256[] private _attackWeights;
    uint256 private _attackNonce;
    uint256 private _attackExpiry;
    bytes private _attackSignature;

    /// @notice Loads the pre-signed second allocation and enables the attack.
    /// @dev Stored field-by-field rather than as a nested struct so the test can
    ///      pass exactly the tuple it signed, with no re-encoding step in
    ///      between that could silently alter the payload the signature covers.
    function armAttack(
        address targetManager,
        address[] calldata assets,
        uint256[] calldata weights,
        uint256 nonce,
        uint256 expiry,
        bytes calldata signature
    ) external {
        target = RiskLegManager(targetManager);
        _attackAssets = assets;
        _attackWeights = weights;
        _attackNonce = nonce;
        _attackExpiry = expiry;
        _attackSignature = signature;
        attackEnabled = true;
        attackAttempted = false;
    }

    /// @notice Stands the attack down, leaving a fully functional router.
    function disarmAttack() external {
        attackEnabled = false;
    }

    /// @notice The armed payload, so a test can resubmit the identical
    ///         allocation through the normal path as a control.
    function armedAllocation()
        external
        view
        returns (address[] memory assets, uint256[] memory weights, uint256 nonce, uint256 expiry, bytes memory signature)
    {
        return (_attackAssets, _attackWeights, _attackNonce, _attackExpiry, _attackSignature);
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        public
        payable
        override
        returns (uint256 amountOut)
    {
        // Reentry is attempted BEFORE delegating to the honest swap, i.e. while
        // the outer rebalance is mid-flight with its guard held and its balances
        // partially updated — the exact window the guard exists to close.
        //
        // `attackAttempted` bounds this to a single attempt. It is not what stops
        // the recursion (the target's guard does that); it exists so a disarmed
        // or post-attempt call behaves like an ordinary router.
        if (attackEnabled && !attackAttempted) {
            attackAttempted = true;

            // Qualified by AllocationSigning, the contract that DECLARES the
            // struct — Solidity does not expose an inherited struct through the
            // deriving contract's name (`RiskLegManager.SignedAllocation` does
            // not resolve). Same type either way; RiskLegManager inherits it.
            AllocationSigning.SignedAllocation memory reentrantAllocation = AllocationSigning.SignedAllocation({
                assets: _attackAssets,
                weights: _attackWeights,
                nonce: _attackNonce,
                expiry: _attackExpiry
            });

            // No try/catch, deliberately. The revert must reach the test
            // unaltered so it can assert on ReentrancyGuardReentrantCall
            // specifically — an error only OZ's ReentrancyGuard raises, which is
            // what proves the call actually entered the guarded function rather
            // than failing earlier for some unrelated reason.
            target.submitRebalanceTarget(reentrantAllocation, _attackSignature);
        }

        return super.exactInputSingle(params);
    }
}
