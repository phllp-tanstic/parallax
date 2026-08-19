// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ISafeLegManager {
    function depositSafeLeg(uint256 noteId, uint256 amount) external;
    function withdrawSafeLeg(uint256 noteId) external returns (uint256 amountReturned);
    function getSafeLegValue(uint256 noteId) external view returns (uint256);
}