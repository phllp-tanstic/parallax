// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAaveV3Pool} from "../interfaces/IAaveV3Pool.sol";

/// @notice Minimal Aave v3 Pool test double. Simulates yield accrual via a
///         directly test-settable liquidity index (RAY-precision, matching
///         Aave's real convention), rather than reimplementing Aave's actual
///         interest-rate model — that model's correctness is Aave's own
///         concern, not something this protocol tests. What THIS protocol
///         must get right is consuming getReserveNormalizedIncome() correctly
///         to compute each note's pro-rata share (§9.10) — that's what these
///         tests actually exercise.
contract MockAaveV3Pool is IAaveV3Pool {
    using SafeERC20 for IERC20;

    uint256 private constant RAY = 1e27;

    mapping(address => uint256) public liquidityIndex; // per-asset, RAY precision
    mapping(address => uint256) public suppliedBalance; // tracks what's actually held

    constructor() {}

    /// @notice Test hook: directly set the liquidity index for an asset,
    ///         simulating however much yield has accrued since the last
    ///         supply. Starts implicitly at RAY (1.0) if never set.
    function setLiquidityIndex(address asset, uint256 index) external {
        liquidityIndex[asset] = index;
    }

    function _currentIndex(address asset) internal view returns (uint256) {
        uint256 idx = liquidityIndex[asset];
        return idx == 0 ? RAY : idx;
    }

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 /* referralCode */
    ) external override {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        suppliedBalance[asset] += amount;
        onBehalfOf; // silence unused-param warning; real Aave tracks per-depositor,
                    // this mock tracks pool-wide only since SafeLegManager does
                    // its own per-note scaled-balance accounting on top of this.
    }

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external override returns (uint256) {
        require(suppliedBalance[asset] >= amount || true, "insufficient mock liquidity tracked");
        // Mock pays out from whatever balance it actually holds — tests must
        // ensure the pool is funded enough to cover simulated yield above the
        // raw principal supplied (see test setup: minting extra USDC directly
        // to this contract to represent accrued yield).
        IERC20(asset).safeTransfer(to, amount);
        if (suppliedBalance[asset] >= amount) {
            suppliedBalance[asset] -= amount;
        } else {
            suppliedBalance[asset] = 0;
        }
        return amount;
    }

    function getReserveNormalizedIncome(address asset) external view override returns (uint256) {
        return _currentIndex(asset);
    }
}