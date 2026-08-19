// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAaveV3Pool} from "./interfaces/IAaveV3Pool.sol";
import {ISafeLegManager} from "./interfaces/ISafeLegManager.sol";

/// @title SafeLegManager
/// @notice Holds the safe-leg (Aave-deposited) portion of every Parallax note,
///         per docs/parallax_litepaper.md §6, §9.1, §9.8.
/// @dev Deliberately separate from RiskLegManager and ParallaxVault so a bug in
///      DEX/risk-leg logic cannot touch Aave-held principal. This contract has
///      NO knowledge of §9.3 allocation logic, DEX routers, or risk-leg
///      accounting whatsoever.
///
///      Per-note accrual tracking: Aave's aToken balance rebases for the whole
///      pooled deposit, not per depositor. To give each note its own correct
///      pro-rata share of accrued yield (not just an even split), this contract
///      replicates Aave's own scaled-balance mechanism internally: each note's
///      deposit is recorded as `amount * RAY / liquidityIndexAtDeposit`, and its
///      current value at any later time is `scaledAmount * currentLiquidityIndex
///      / RAY` — exactly how aToken.balanceOf() computes value internally. This
///      is not a novel accounting scheme; it mirrors Aave's own math so every
///      note earns precisely the yield its own deposit generated, regardless of
///      when other notes were issued or redeemed.
contract SafeLegManager is ISafeLegManager, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant RAY = 1e27;

    error VaultAlreadySet();
    error CallerNotVault(address caller);
    error NoteAlreadyDeposited(uint256 noteId);
    error NoteNotDeposited(uint256 noteId);
    error NoteAlreadyWithdrawn(uint256 noteId);

    IERC20 public immutable usdc;
    IAaveV3Pool public immutable aavePool;

    address public vault;

    struct SafeLegPosition {
        uint256 scaledAmount; // Aave-style scaled balance, RAY-precision
        bool deposited;
        bool withdrawn;
    }

    mapping(uint256 => SafeLegPosition) private _positions;

    event VaultSet(address indexed vault);
    event SafeLegDeposited(uint256 indexed noteId, uint256 amount, uint256 scaledAmount);
    event SafeLegWithdrawn(uint256 indexed noteId, uint256 amountReturned);

    modifier onlyVault() {
        if (msg.sender != vault) revert CallerNotVault(msg.sender);
        _;
    }

    constructor(address usdcAddress, address aavePoolAddress) Ownable(msg.sender) {
        usdc = IERC20(usdcAddress);
        aavePool = IAaveV3Pool(aavePoolAddress);
    }

    /// @notice One-time vault wiring, set by the deployer after ParallaxVault
    ///         is deployed (constructor chicken-and-egg: the vault's constructor
    ///         needs this contract's address, so this contract can't take the
    ///         vault's address in ITS constructor). Settable exactly once —
    ///         deliberately NOT re-settable, since a re-settable trusted caller
    ///         address would let the owner redirect fund flows to an arbitrary
    ///         contract post-deployment, which is a rug-pull vector this design
    ///         explicitly closes off.
    function setVault(address vaultAddress) external onlyOwner {
        if (vault != address(0)) revert VaultAlreadySet();
        vault = vaultAddress;
        emit VaultSet(vaultAddress);
    }

    /// @dev §7 step 3: "The contract deposits the safe-leg amount into Aave."
    function depositSafeLeg(uint256 noteId, uint256 amount) external onlyVault {
        if (_positions[noteId].deposited) revert NoteAlreadyDeposited(noteId);

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(address(aavePool), amount);
        aavePool.supply(address(usdc), amount, address(this), 0);

        uint256 liquidityIndex = aavePool.getReserveNormalizedIncome(address(usdc));
        uint256 scaledAmount = (amount * RAY) / liquidityIndex;

        _positions[noteId] = SafeLegPosition({
            scaledAmount: scaledAmount,
            deposited: true,
            withdrawn: false
        });

        emit SafeLegDeposited(noteId, amount, scaledAmount);
    }

    /// @dev §7 step 6: "the safe leg is withdrawn from Aave (= full principal,
    ///      guaranteed)." Returns USDC to the vault, which forwards to the note
    ///      owner — this contract never sends funds directly to end users,
    ///      keeping a single user-facing transfer point in ParallaxVault.
    function withdrawSafeLeg(uint256 noteId) external onlyVault returns (uint256 amountReturned) {
        SafeLegPosition storage position = _positions[noteId];
        if (!position.deposited) revert NoteNotDeposited(noteId);
        if (position.withdrawn) revert NoteAlreadyWithdrawn(noteId);

        uint256 liquidityIndex = aavePool.getReserveNormalizedIncome(address(usdc));
        uint256 currentValue = (position.scaledAmount * liquidityIndex) / RAY;

        position.withdrawn = true;

        amountReturned = aavePool.withdraw(address(usdc), currentValue, msg.sender);

        emit SafeLegWithdrawn(noteId, amountReturned);
    }

    /// @notice Current value of a note's safe-leg position, per §10.7 vault
    ///         accounting test requirements. View-only, no state change.
    function getSafeLegValue(uint256 noteId) external view returns (uint256) {
        SafeLegPosition storage position = _positions[noteId];
        if (!position.deposited) revert NoteNotDeposited(noteId);
        if (position.withdrawn) return 0;

        uint256 liquidityIndex = aavePool.getReserveNormalizedIncome(address(usdc));
        return (position.scaledAmount * liquidityIndex) / RAY;
    }
}