// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Uniswap V3 SwapRouter interface — only exactInputSingle, the only
///         swap type RiskLegManager needs for §9.3 rebalance execution.
/// @dev §9.9 flags that the confirmed wNVDAx/USDG pool is V3 (concentrated liquidity),
///      not V2 constant-product — this interface reflects that confirmed pool type.
///      Slippage protection is via `amountOutMinimum`, computed off-chain per the
///      cost-gating logic in §9.5/§9.9 and passed in, never computed on-chain from a
///      spot price (which would be manipulable within the same transaction).
interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}