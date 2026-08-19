// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Aave v3.6 Pool interface — only the functions SafeLegManager needs.
/// @dev Deliberately not importing Aave's full interface package to avoid pulling in
///      surface area (flash loans, e-mode, etc.) this protocol never uses — smaller
///      attack surface, easier audit. Matches docs/parallax_litepaper.md §6 (safe leg
///      = real Aave lending position, nothing synthetic).
interface IAaveV3Pool {
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);

    /// @notice Returns the current liquidity index for reserve interest accrual.
    /// @dev Used to compute accrued yield without a separate oracle call.
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
}