// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ISafeLegManager} from "./interfaces/ISafeLegManager.sol";
import {IRiskLegManager} from "./interfaces/IRiskLegManager.sol";

/// @title ParallaxVault
/// @notice Principal-protected structured note issuance and redemption core.
///         Implements docs/parallax_litepaper.md §6, §7, §12 (issueNote/redeem
///         checklist items), §13 (MVP scope: single 365-day term, non-transferable,
///         hard deposit cap).
/// @dev This is the ONLY contract users interact with directly. It owns note
///      accounting and delegates leg-specific logic to SafeLegManager and
///      RiskLegManager — kept thin deliberately (§6: two independently-tracked
///      on-chain positions, separated at the contract-type level, not just by
///      convention, so a bug in risk-leg DEX logic cannot touch the safe leg).
///
///      Security posture per §12 checklist: no admin withdrawal function exists
///      anywhere in this contract — Pausable is the only emergency control,
///      disclosed as a safety rail, not a fund-access mechanism.
///
///      ARCHITECTURE NOTE: risk-service signer state (riskServiceSigner,
///      allocationNonce) and the EIP-712 AllocationSigning inheritance were
///      moved OUT of this contract and into RiskLegManager, since that is the
///      contract that owns the asset whitelist, asset classes, and previous-
///      allocation state needed for signature verification and §9.8 hard-
///      bounds checks. This vault has no signing-related state at all.
contract ParallaxVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroPrincipal();
    error BelowMinimumDeposit(uint256 provided, uint256 minimum);
    error DepositCapExceeded(uint256 wouldBeTotal, uint256 cap);
    error NoteNotFound(uint256 noteId);
    error NotNoteOwner(address caller, uint256 noteId);
    error NoteAlreadyRedeemed(uint256 noteId);
    error NoteNotYetMatured(uint256 noteId, uint256 maturesAt, uint256 blockTimestamp);
    error TransferNotSupported();
    error EarlyExitPenaltyTooHigh(uint256 providedBps);

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @dev §13: single 365-day term, non-transferable, so a note is identified
    ///      by an incrementing ID and owner mapping — not an ERC-721.
    struct Note {
        address owner;
        uint256 principal;      // original USDC deposit, §9.1
        uint256 safeLegAmount;  // computed at issuance, §9.1
        uint256 riskLegAmount;  // computed at issuance, §9.1
        uint256 issuedAt;
        uint256 maturesAt;      // issuedAt + TERM_DURATION, §13
        bool redeemed;
    }

    // ---------------------------------------------------------------------
    // Immutables / constants
    // ---------------------------------------------------------------------

    /// @dev §13: "Single 365-day term only" — MVP scope, not a shortcut.
    uint256 public constant TERM_DURATION = 365 days;

    IERC20 public immutable usdc;
    ISafeLegManager public immutable safeLegManager;
    IRiskLegManager public immutable riskLegManager;

    // ---------------------------------------------------------------------
    // Mutable state
    // ---------------------------------------------------------------------

    uint256 public depositCap;
    uint256 public totalDeposited;

    uint256 public conservativeRateBps; // e.g. 500 = 5% APY, expressed in bps

    uint256 public minimumDeposit;

    uint256 private _nextNoteId;
    mapping(uint256 => Note) private _notes;

    /// @dev §9.7 MVP default: "simple, disclosed penalty-based pricing (not yet
    ///      formula-specified)." Penalty applies ONLY to the risk-leg payout,
    ///      never the safe leg — see redeemEarly() for the full rationale.
    uint256 public earlyExitPenaltyBps;
    uint256 private constant MAX_EARLY_EXIT_PENALTY_BPS = 5_000;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event NoteIssued(
        uint256 indexed noteId,
        address indexed owner,
        uint256 principal,
        uint256 safeLegAmount,
        uint256 riskLegAmount,
        uint256 maturesAt
    );
    event DepositCapUpdated(uint256 oldCap, uint256 newCap);
    event ConservativeRateUpdated(uint256 oldRateBps, uint256 newRateBps);
    event MinimumDepositUpdated(uint256 oldMinimum, uint256 newMinimum);

    event NoteRedeemed(
        uint256 indexed noteId,
        address indexed owner,
        uint256 safeLegPayout,
        uint256 riskLegPayout,
        uint256 totalPayout,
        bool wasEarlyExit
    );
    event EarlyExitPenaltyUpdated(uint256 oldPenaltyBps, uint256 newPenaltyBps);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(
        address usdcAddress,
        address safeLegManagerAddress,
        address riskLegManagerAddress,
        uint256 initialDepositCap,
        uint256 initialConservativeRateBps,
        uint256 initialMinimumDeposit,
        uint256 initialEarlyExitPenaltyBps
    ) Ownable(msg.sender) {
        usdc = IERC20(usdcAddress);
        safeLegManager = ISafeLegManager(safeLegManagerAddress);
        riskLegManager = IRiskLegManager(riskLegManagerAddress);
        depositCap = initialDepositCap;
        conservativeRateBps = initialConservativeRateBps;
        minimumDeposit = initialMinimumDeposit;

        if (initialEarlyExitPenaltyBps > MAX_EARLY_EXIT_PENALTY_BPS) {
            revert EarlyExitPenaltyTooHigh(initialEarlyExitPenaltyBps);
        }
        earlyExitPenaltyBps = initialEarlyExitPenaltyBps;
    }

    // ---------------------------------------------------------------------
    // Note issuance — §7 step 1-4, §12 checklist
    // ---------------------------------------------------------------------

    function issueNote(uint256 principal) external whenNotPaused nonReentrant returns (uint256 noteId) {
        if (principal == 0) revert ZeroPrincipal();
        if (principal < minimumDeposit) {
            revert BelowMinimumDeposit(principal, minimumDeposit);
        }

        uint256 wouldBeTotal = totalDeposited + principal;
        if (wouldBeTotal > depositCap) {
            revert DepositCapExceeded(wouldBeTotal, depositCap);
        }

        usdc.safeTransferFrom(msg.sender, address(this), principal);

        (uint256 safeLegAmount, uint256 riskLegAmount) = _computeSafeLeg(principal);

        noteId = _nextNoteId++;
        uint256 maturesAt = block.timestamp + TERM_DURATION;

        _notes[noteId] = Note({
            owner: msg.sender,
            principal: principal,
            safeLegAmount: safeLegAmount,
            riskLegAmount: riskLegAmount,
            issuedAt: block.timestamp,
            maturesAt: maturesAt,
            redeemed: false
        });

        totalDeposited = wouldBeTotal;

        usdc.safeIncreaseAllowance(address(safeLegManager), safeLegAmount);
        safeLegManager.depositSafeLeg(noteId, safeLegAmount);

        usdc.safeIncreaseAllowance(address(riskLegManager), riskLegAmount);
        riskLegManager.depositRiskLeg(noteId, riskLegAmount);

        emit NoteIssued(noteId, msg.sender, principal, safeLegAmount, riskLegAmount, maturesAt);
    }

    /// @dev §9.1 formula collapsed for t=1 (365-day MVP term, §13). See
    ///      historical design note: NOT a general-t implementation.
    function _computeSafeLeg(uint256 principal)
        internal
        view
        returns (uint256 safeLegAmount, uint256 riskLegAmount)
    {
        safeLegAmount = (principal * 10_000) / (10_000 + conservativeRateBps);
        riskLegAmount = principal - safeLegAmount;
    }

    // ---------------------------------------------------------------------
    // Redemption — §7 step 6-7, §12 checklist, §10.10 lifecycle tests
    // ---------------------------------------------------------------------

    function redeemAtMaturity(uint256 noteId) external nonReentrant returns (uint256 totalPayout) {
        Note storage note = _notes[noteId];
        if (note.owner == address(0)) revert NoteNotFound(noteId);
        if (note.owner != msg.sender) revert NotNoteOwner(msg.sender, noteId);
        if (note.redeemed) revert NoteAlreadyRedeemed(noteId);
        if (block.timestamp < note.maturesAt) {
            revert NoteNotYetMatured(noteId, note.maturesAt, block.timestamp);
        }

        note.redeemed = true;

        uint256 safeLegPayout = safeLegManager.withdrawSafeLeg(noteId);
        uint256 riskLegPayout = riskLegManager.withdrawRiskLeg(noteId);
        totalPayout = safeLegPayout + riskLegPayout;

        usdc.safeTransfer(msg.sender, totalPayout);

        emit NoteRedeemed(noteId, msg.sender, safeLegPayout, riskLegPayout, totalPayout, false);
    }

    /// @notice Redeems a note before maturity, forfeiting the full-principal
    ///         guarantee in exchange for immediate liquidity.
    /// @dev §7 step 7. PENALTY SCOPE (explicit decision): applies ONLY to the
    ///      risk-leg payout, never to the safe leg — the safe leg's
    ///      Aave-accrued value up to the moment of exit is paid out in full,
    ///      unpenalized. A penalty clawing back accrued safe-leg yield would
    ///      be inconsistent with ever calling it "guaranteed." §10.10's
    ///      forfeiture requirement is still satisfied — the safe leg pays its
    ///      CURRENT accrued value, not the full `principal`, since maturity
    ///      hasn't been reached.
    function redeemEarly(uint256 noteId) external nonReentrant returns (uint256 totalPayout) {
        Note storage note = _notes[noteId];
        if (note.owner == address(0)) revert NoteNotFound(noteId);
        if (note.owner != msg.sender) revert NotNoteOwner(msg.sender, noteId);
        if (note.redeemed) revert NoteAlreadyRedeemed(noteId);

        note.redeemed = true;

        uint256 safeLegPayout = safeLegManager.withdrawSafeLeg(noteId);
        uint256 riskLegPayout = riskLegManager.withdrawRiskLeg(noteId);

        uint256 riskLegPenalty = (riskLegPayout * earlyExitPenaltyBps) / 10_000;
        uint256 riskLegPayoutAfterPenalty = riskLegPayout - riskLegPenalty;

        totalPayout = safeLegPayout + riskLegPayoutAfterPenalty;

        usdc.safeTransfer(msg.sender, totalPayout);

        emit NoteRedeemed(noteId, msg.sender, safeLegPayout, riskLegPayoutAfterPenalty, totalPayout, true);
    }

    function setEarlyExitPenaltyBps(uint256 newPenaltyBps) external onlyOwner {
        if (newPenaltyBps > MAX_EARLY_EXIT_PENALTY_BPS) {
            revert EarlyExitPenaltyTooHigh(newPenaltyBps);
        }
        emit EarlyExitPenaltyUpdated(earlyExitPenaltyBps, newPenaltyBps);
        earlyExitPenaltyBps = newPenaltyBps;
    }

    // ---------------------------------------------------------------------
    // View helpers
    // ---------------------------------------------------------------------

    function getNote(uint256 noteId) external view returns (Note memory) {
        if (_notes[noteId].owner == address(0)) revert NoteNotFound(noteId);
        return _notes[noteId];
    }

    // ---------------------------------------------------------------------
    // Admin (owner-gated, no fund-access capability — §12 Security checklist)
    // ---------------------------------------------------------------------

    function setDepositCap(uint256 newCap) external onlyOwner {
        emit DepositCapUpdated(depositCap, newCap);
        depositCap = newCap;
    }

    function setConservativeRateBps(uint256 newRateBps) external onlyOwner {
        emit ConservativeRateUpdated(conservativeRateBps, newRateBps);
        conservativeRateBps = newRateBps;
    }

    function setMinimumDeposit(uint256 newMinimum) external onlyOwner {
        emit MinimumDepositUpdated(minimumDeposit, newMinimum);
        minimumDeposit = newMinimum;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}