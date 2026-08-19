// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IRiskLegManager {
    function depositRiskLeg(uint256 noteId, uint256 amount) external;
    function withdrawRiskLeg(uint256 noteId) external returns (uint256 amountReturned);
    function getRiskLegValue(uint256 noteId) external view returns (uint256);
}