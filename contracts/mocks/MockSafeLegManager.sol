// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISafeLegManager} from "../interfaces/ISafeLegManager.sol";

/// @notice Test double for ISafeLegManager. Lets tests directly control the
///         "accrued value" returned on withdrawal, simulating Aave yield
///         without needing a real Aave pool — isolates ParallaxVault's own
///         logic from SafeLegManager's internal accounting correctness
///         (which has its own separate test coverage against real Aave
///         semantics, per §10.4/§10.7).
contract MockSafeLegManager is ISafeLegManager {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    mapping(uint256 => uint256) public depositedAmount;
    mapping(uint256 => uint256) public withdrawValueOverride; // 0 = use deposited amount as-is
    mapping(uint256 => bool) public deposited;
    mapping(uint256 => bool) public withdrawn;

    constructor(address usdcAddress) {
        usdc = IERC20(usdcAddress);
    }

    function depositSafeLeg(uint256 noteId, uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        depositedAmount[noteId] = amount;
        deposited[noteId] = true;
    }

    /// @notice Test hook: set the value this mock returns on withdrawal for a
    ///         given note, simulating accrued Aave yield (or a shortfall,
    ///         though §9.1's guarantee means this should never be below the
    ///         computed safe-leg amount in a real deployment).
    function setWithdrawValue(uint256 noteId, uint256 value) external {
        withdrawValueOverride[noteId] = value;
    }

    function withdrawSafeLeg(uint256 noteId) external returns (uint256 amountReturned) {
        require(deposited[noteId], "not deposited");
        require(!withdrawn[noteId], "already withdrawn");
        withdrawn[noteId] = true;

        amountReturned = withdrawValueOverride[noteId] != 0
            ? withdrawValueOverride[noteId]
            : depositedAmount[noteId];

        // Mock must actually hold enough USDC to pay out — tests fund this
        // contract directly when simulating yield above the deposited amount.
        usdc.safeTransfer(msg.sender, amountReturned);
    }

    function getSafeLegValue(uint256 noteId) external view returns (uint256) {
        if (!deposited[noteId] || withdrawn[noteId]) return 0;
        return withdrawValueOverride[noteId] != 0
            ? withdrawValueOverride[noteId]
            : depositedAmount[noteId];
    }
}