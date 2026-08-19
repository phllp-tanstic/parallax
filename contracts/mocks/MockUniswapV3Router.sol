// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV3Router} from "../interfaces/IUniswapV3Router.sol";

/// @notice Minimal Uniswap V3 SwapRouter test double for RiskLegManager's
///         rebalance-execution tests.
///
/// @dev WHAT THIS SIMULATES: the router's observable contract — pull `amountIn`
///      of `tokenIn` from the caller, deliver some `amountOut` of `tokenOut` to
///      `recipient`, revert if that output would fall below
///      `amountOutMinimum`, and revert past `deadline`. Output is computed from
///      a test-settable per-pair exchange rate plus an optional haircut, so a
///      test can express "the pool filled at exactly the oracle-fair rate" or
///      "the pool filled 3% worse than oracle-fair" deterministically.
///
///      WHAT THIS DELIBERATELY DOES NOT SIMULATE: concentrated-liquidity tick
///      math, price impact as a function of trade size, or fee-tier-dependent
///      pricing. Those are Uniswap's own concern, and — critically — modelling
///      them here would be inventing the very V3-native slippage curve that
///      docs/parallax_litepaper.md §9.9 flags as an OPEN, UNVALIDATED item
///      (§16 item 2, §17 item 2). A mock that produced plausible-looking V3
///      price impact would make the untested cost model look validated. It is
///      not. What these tests DO verify is that RiskLegManager computes its
///      `amountOutMinimum` from the ORACLE and that the swap reverts when the
///      pool cannot meet it — which is the protocol-side guarantee, and is
///      independent of the exact shape of the real slippage curve.
///
///      The `fee` tier is recorded for assertion but does not affect pricing
///      here; tests assert RiskLegManager passes the tier it was configured
///      with, not that the tier prices correctly (again: Uniswap's concern).
contract MockUniswapV3Router is IUniswapV3Router {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    error RateNotSet(address tokenIn, address tokenOut);
    error DeadlinePassed(uint256 deadline, uint256 blockTimestamp);
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMinimum);
    error InsufficientMockLiquidity(address tokenOut, uint256 required, uint256 held);
    error InvalidHaircut(uint256 haircutBps);

    /// @dev amountOut = amountIn * rateNumerator / rateDenominator, before any
    ///      haircut. Expressed as an explicit fraction rather than a single
    ///      "price" so a test can encode any token-decimals pairing without the
    ///      mock needing to know either token's decimals.
    mapping(address => mapping(address => uint256)) public rateNumerator;
    mapping(address => mapping(address => uint256)) public rateDenominator;

    /// @dev Fraction of the fair output withheld, simulating real execution
    ///      landing worse than the oracle-implied fair rate. 0 = fill exactly
    ///      at the configured rate.
    uint256 public outputHaircutBps;

    struct LastSwap {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        uint256 amountOut;
    }

    LastSwap public lastSwap;
    uint256 public swapCount;

    /// @notice Test hook: set the fair exchange rate for one direction of a
    ///         pair. Both directions must be set independently — the mock does
    ///         not infer the inverse, because inferring it would silently
    ///         introduce a rounding asymmetry the test author didn't choose.
    function setRate(
        address tokenIn,
        address tokenOut,
        uint256 numerator,
        uint256 denominator
    ) external {
        rateNumerator[tokenIn][tokenOut] = numerator;
        rateDenominator[tokenIn][tokenOut] = denominator;
    }

    /// @notice Test hook: withhold `haircutBps` of the fair output on every
    ///         subsequent swap, simulating adverse execution.
    function setOutputHaircutBps(uint256 haircutBps) external {
        if (haircutBps > BPS_DENOMINATOR) revert InvalidHaircut(haircutBps);
        outputHaircutBps = haircutBps;
    }

    /// @notice Fair output for a given input, ignoring the haircut. Lets tests
    ///         assert against the mock's own arithmetic rather than duplicating
    ///         it in JavaScript.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 denominator = rateDenominator[tokenIn][tokenOut];
        if (denominator == 0) revert RateNotSet(tokenIn, tokenOut);
        return (amountIn * rateNumerator[tokenIn][tokenOut]) / denominator;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        if (block.timestamp > params.deadline) {
            revert DeadlinePassed(params.deadline, block.timestamp);
        }

        amountOut = quote(params.tokenIn, params.tokenOut, params.amountIn);
        if (outputHaircutBps > 0) {
            amountOut = (amountOut * (BPS_DENOMINATOR - outputHaircutBps)) / BPS_DENOMINATOR;
        }

        // Checked BEFORE moving any tokens, mirroring the real router's
        // all-or-nothing behavior: a swap that cannot meet the caller's
        // minimum must leave the caller's balances untouched.
        if (amountOut < params.amountOutMinimum) {
            revert InsufficientOutputAmount(amountOut, params.amountOutMinimum);
        }

        uint256 held = IERC20(params.tokenOut).balanceOf(address(this));
        if (held < amountOut) {
            revert InsufficientMockLiquidity(params.tokenOut, amountOut, held);
        }

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);

        lastSwap = LastSwap({
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            fee: params.fee,
            recipient: params.recipient,
            deadline: params.deadline,
            amountIn: params.amountIn,
            amountOutMinimum: params.amountOutMinimum,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96,
            amountOut: amountOut
        });
        swapCount += 1;
    }
}
