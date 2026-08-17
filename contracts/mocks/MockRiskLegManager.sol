// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IRiskLegManager} from "../interfaces/IRiskLegManager.sol";

/// @notice Test double for IRiskLegManager, same rationale as
///         MockSafeLegManager — isolates ParallaxVault's redemption/penalty
///         logic from RiskLegManager's own (separately tested) allocation
///         and valuation correctness.
contract MockRiskLegManager is IRiskLegManager {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    mapping(uint256 => uint256) public depositedAmount;
    mapping(uint256 => uint256) public withdrawValueOverride;
    mapping(uint256 => bool) public deposited;
    mapping(uint256 => bool) public withdrawn;

    constructor(address usdcAddress) {
        usdc = IERC20(usdcAddress);
    }

    function depositRiskLeg(uint256 noteId, uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        depositedAmount[noteId] = amount;
        deposited[noteId] = true;
    }

    /// @notice Test hook: set the value this mock returns on withdrawal,
    ///         simulating risk-leg gains or losses.
    function setWithdrawValue(uint256 noteId, uint256 value) external {
        withdrawValueOverride[noteId] = value;
    }

    function withdrawRiskLeg(uint256 noteId) external returns (uint256 amountReturned) {
        require(deposited[noteId], "not deposited");
        require(!withdrawn[noteId], "already withdrawn");
        withdrawn[noteId] = true;

        amountReturned = withdrawValueOverride[noteId] != 0
            ? withdrawValueOverride[noteId]
            : depositedAmount[noteId];

        usdc.safeTransfer(msg.sender, amountReturned);
    }

    function getRiskLegValue(uint256 noteId) external view returns (uint256) {
        if (!deposited[noteId] || withdrawn[noteId]) return 0;
        return withdrawValueOverride[noteId] != 0
            ? withdrawValueOverride[noteId]
            : depositedAmount[noteId];
    }
}