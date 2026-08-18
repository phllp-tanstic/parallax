// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IRiskLegManager} from "./interfaces/IRiskLegManager.sol";
import {AllocationSigning} from "./libraries/AllocationSigning.sol";
import {HardBounds} from "./libraries/HardBounds.sol";

/// @title RiskLegManager
/// @notice Holds and allocates the risk-leg portion of every Parallax note
///         across crypto/xStocks assets per docs/parallax_litepaper.md §9.3,
///         §9.5, §9.6, §9.8, §9.10.
/// @dev ARCHITECTURE NOTE: riskServiceSigner, allocationNonce, and the
///      AllocationSigning inheritance were originally placed on ParallaxVault
///      (built before this execution layer was designed) and have been moved
///      here. This is the contract that owns the asset whitelist, asset-class
///      mapping, and previous-allocation state needed for signature
///      verification and hard-bounds checks — keeping the signer scaffolding
///      on the vault would have meant either duplicating that state in two
///      places or forcing cross-contract calls for every bounds check on
///      every submission. Moved once, documented, not duplicated.
///
///      SCOPE OF THIS COMMIT: implements the DECISION layer only —
///      signature verification, hard-bounds enforcement, on-chain-derived
///      de-risk/re-risk classification (§9.5/§9.6), and the confirmation-
///      delay state machine. `_executeAllocation` currently only UPDATES
///      the contract's recorded target allocation and emits an event — it
///      does NOT yet perform real DEX swaps via IUniswapV3Router. That is
///      deliberately separate, larger follow-up work (needs OracleConsumer-
///      priced slippage protection, §9.9's V3-native cost model, and actual
///      swap routing) — building it on top of an unverified decision layer
///      would mean debugging both at once. This layer is fully testable in
///      isolation first.
///
///      CLASSIFICATION METHOD (confirmed design decision, NOT from the
///      litepaper verbatim — the litepaper's §9.6 trigger condition compares
///      target/current AVERAGE VOLATILITY, which has no on-chain oracle and
///      would require replicating the off-chain §9.2 semi-covariance engine
///      on-chain, out of scope for anyone). Instead, de-risk/re-risk is
///      derived on-chain from data the contract already has: crypto is the
///      structurally higher-volatility asset class (why the diversification
///      floor treats crypto/equity as distinct classes at all). A submission
///      is classified as de-risk if it does not increase total crypto-class
///      weight versus the last EXECUTED allocation, re-risk otherwise. This
///      is computed by the contract itself from the previous and proposed
///      weights — never asserted by the off-chain signer — closing a trust
///      gap that a signer-supplied classification flag would have left open
///      (a compromised signer could otherwise mislabel a re-risk as a
///      de-risk to skip the confirmation delay entirely).
///
///      CALENDAR-DAY APPROXIMATION: §9.6 specifies "5 trading days." This
///      contract uses 5 * 24 hours (calendar days) as an explicit, disclosed
///      approximation — an on-chain trading-day calendar accounting for
///      weekends/holidays across mixed equity + always-on crypto markets is
///      unspecified anywhere in the litepaper and out of scope. Flagged
///      here rather than silently treated as equivalent.
contract RiskLegManager is IRiskLegManager, Ownable, AllocationSigning {
    using SafeERC20 for IERC20;

    uint256 private constant RERISK_CONFIRMATION_DELAY = 5 days; // calendar-day
                                                                   // approximation,
                                                                   // see contract note

    enum AssetClass {
        NONE,
        CRYPTO,
        EQUITY
    }

    error VaultAlreadySet();
    error CallerNotVault(address caller);
    error NoteAlreadyDeposited(uint256 noteId);
    error NoteNotDeposited(uint256 noteId);
    error NoteAlreadyWithdrawn(uint256 noteId);
    error ZeroSharePrice();
    error InvalidSignature();

    IERC20 public immutable usdc;
    address public vault;

    uint256 public totalShares;

    struct RiskLegPosition {
        uint256 shares;
        bool deposited;
        bool withdrawn;
    }

    mapping(uint256 => RiskLegPosition) private _positions;

    // -- §9.3/§9.8 asset configuration, address-keyed per §10.6 discipline --
    mapping(address => bool) public assetWhitelisted;
    mapping(address => AssetClass) public assetClass;

    // -- §9.8 signer scaffolding, moved from ParallaxVault (see note above) --
    address public riskServiceSigner;
    uint256 public allocationNonce;

    // -- current on-chain-recorded target allocation, used for delta checks
    //    and de-risk/re-risk classification --
    struct AllocationState {
        address[] assets;
        uint256[] weightsBps;
    }
    AllocationState private _currentAllocation;

    // -- §9.6 confirmation-delay state machine --
    struct PendingSignal {
        bool exists;
        uint256 firstSeenAt;
    }
    PendingSignal public pendingReRiskSignal;

    event VaultSet(address indexed vault);
    event RiskLegDeposited(uint256 indexed noteId, uint256 amount, uint256 shares);
    event RiskLegWithdrawn(uint256 indexed noteId, uint256 amountReturned);
    event AssetConfigured(address indexed asset, bool whitelisted, AssetClass assetClass);
    event RiskServiceSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event ReRiskSignalRecorded(uint256 timestamp);
    event ReRiskSignalCleared();
    event RebalanceExecuted(address[] assets, uint256[] weightsBps, bool wasReRisk);

    modifier onlyVault() {
        if (msg.sender != vault) revert CallerNotVault(msg.sender);
        _;
    }

    constructor(address usdcAddress)
        Ownable(msg.sender)
        AllocationSigning("ParallaxRiskLegManager", "1")
    {
        usdc = IERC20(usdcAddress);
    }

    function setVault(address vaultAddress) external onlyOwner {
        if (vault != address(0)) revert VaultAlreadySet();
        vault = vaultAddress;
        emit VaultSet(vaultAddress);
    }

    /// @dev §9.8/§17: signer upgrade path (EOA -> Gnosis Safe later), no
    ///      interface change required, per AllocationSigning's ERC-1271
    ///      support via OZ's SignatureChecker.
    function setRiskServiceSigner(address newSigner) external onlyOwner {
        emit RiskServiceSignerUpdated(riskServiceSigner, newSigner);
        riskServiceSigner = newSigner;
    }

    /// @notice Registers an asset's whitelist status and class, per §9.8/§10.6.
    function configureAsset(address asset, bool whitelisted, AssetClass class_) external onlyOwner {
        assetWhitelisted[asset] = whitelisted;
        assetClass[asset] = class_;
        emit AssetConfigured(asset, whitelisted, class_);
    }

    // -------------------------------------------------------------------------
    // Deposit / withdraw — unchanged from prior commit
    // -------------------------------------------------------------------------

    function depositRiskLeg(uint256 noteId, uint256 amount) external onlyVault {
        if (_positions[noteId].deposited) revert NoteAlreadyDeposited(noteId);

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 shares;
        if (totalShares == 0) {
            shares = amount;
        } else {
            uint256 poolValueBeforeDeposit = _totalPoolValue() - amount;
            if (poolValueBeforeDeposit == 0) revert ZeroSharePrice();
            shares = (amount * totalShares) / poolValueBeforeDeposit;
        }

        totalShares += shares;
        _positions[noteId] = RiskLegPosition({shares: shares, deposited: true, withdrawn: false});

        emit RiskLegDeposited(noteId, amount, shares);
    }

    function withdrawRiskLeg(uint256 noteId) external onlyVault returns (uint256 amountReturned) {
        RiskLegPosition storage position = _positions[noteId];
        if (!position.deposited) revert NoteNotDeposited(noteId);
        if (position.withdrawn) revert NoteAlreadyWithdrawn(noteId);

        uint256 poolValue = _totalPoolValue();
        amountReturned = (position.shares * poolValue) / totalShares;

        totalShares -= position.shares;
        position.withdrawn = true;

        usdc.safeTransfer(msg.sender, amountReturned);

        emit RiskLegWithdrawn(noteId, amountReturned);
    }

    function getRiskLegValue(uint256 noteId) external view returns (uint256) {
        RiskLegPosition storage position = _positions[noteId];
        if (!position.deposited) revert NoteNotDeposited(noteId);
        if (position.withdrawn) return 0;
        if (totalShares == 0) return 0;

        return (position.shares * _totalPoolValue()) / totalShares;
    }

    function _totalPoolValue() internal view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // -------------------------------------------------------------------------
    // §9.3/§9.5/§9.6/§9.8 — signed allocation submission, decision layer
    // -------------------------------------------------------------------------

    /// @notice Submits a signed target allocation. Verifies the signature and
    ///         every §9.8 hard bound, derives whether this is a de-risk or
    ///         re-risk move on-chain (see contract-level note), and either
    ///         executes immediately (de-risk) or applies the §9.6 5-day
    ///         confirmation delay (re-risk).
    /// @dev Deliberately permissionless (no caller restriction) — security
    ///      lives entirely in signature verification against
    ///      riskServiceSigner plus the hard bounds, not in who calls this.
    ///      This is the standard pattern for signed-order/meta-tx submission.
    function submitRebalanceTarget(
        SignedAllocation calldata allocation,
        bytes calldata signature
    ) external {
        HardBounds.checkArrayLengthsMatch(allocation.assets.length, allocation.weights.length);
        HardBounds.checkNotExpired(allocation.expiry);
        HardBounds.checkNonce(allocationNonce, allocation.nonce);

        bool validSignature = _verifyAllocationSignature(allocation, signature, riskServiceSigner);
        if (!validSignature) revert InvalidSignature();

        HardBounds.checkWeightsSumToOne(allocation.weights);

        for (uint256 i = 0; i < allocation.assets.length; i++) {
            address asset = allocation.assets[i];
            HardBounds.checkWhitelisted(asset, assetWhitelisted);
            HardBounds.checkConcentrationCap(asset, allocation.weights[i]);

            uint256 previousWeight = _weightOf(asset);
            HardBounds.checkMaxDelta(asset, previousWeight, allocation.weights[i]);
        }

        // Nonce is consumed on every submission that passes verification and
        // bounds, whether it executes immediately or only records/advances
        // the re-risk confirmation state — prevents replay of the exact same
        // signed message regardless of outcome.
        allocationNonce++;

        uint256 currentCryptoBps = _sumClassWeight(
            _currentAllocation.assets,
            _currentAllocation.weightsBps,
            AssetClass.CRYPTO
        );
        uint256 newCryptoBps = _sumClassWeight(allocation.assets, allocation.weights, AssetClass.CRYPTO);
        bool isDeRisk = newCryptoBps <= currentCryptoBps;

        if (isDeRisk) {
            if (pendingReRiskSignal.exists) {
                emit ReRiskSignalCleared();
                delete pendingReRiskSignal;
            }
            _executeAllocation(allocation.assets, allocation.weights, false);
            return;
        }

        // Re-risk path — §9.6 confirmation delay.
        if (!pendingReRiskSignal.exists) {
            pendingReRiskSignal = PendingSignal({exists: true, firstSeenAt: block.timestamp});
            emit ReRiskSignalRecorded(block.timestamp);
            return;
        }

        if (block.timestamp - pendingReRiskSignal.firstSeenAt >= RERISK_CONFIRMATION_DELAY) {
            // Execute with FRESH target (this submission's weights), per
            // §9.6's explicit instruction, not the stale weights from the
            // day the signal was first recorded.
            delete pendingReRiskSignal;
            _executeAllocation(allocation.assets, allocation.weights, true);
            return;
        }

        // Signal persists but hasn't reached 5 days yet — continue waiting,
        // no state change beyond the nonce consumption already applied above.
    }

    function _executeAllocation(
        address[] calldata assets,
        uint256[] calldata weightsBps,
        bool wasReRisk
    ) internal {
        // NOTE: state update only — see contract-level scope note. Real DEX
        // swap execution to actually REACH this target allocation is
        // separate follow-up work.
        _currentAllocation.assets = assets;
        _currentAllocation.weightsBps = weightsBps;
        emit RebalanceExecuted(assets, weightsBps, wasReRisk);
    }

    function _weightOf(address asset) internal view returns (uint256) {
        for (uint256 i = 0; i < _currentAllocation.assets.length; i++) {
            if (_currentAllocation.assets[i] == asset) {
                return _currentAllocation.weightsBps[i];
            }
        }
        return 0;
    }

    function _sumClassWeight(
        address[] memory assets,
        uint256[] memory weightsBps,
        AssetClass class_
    ) internal view returns (uint256 sum) {
        for (uint256 i = 0; i < assets.length; i++) {
            if (assetClass[assets[i]] == class_) {
                sum += weightsBps[i];
            }
        }
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    function getCurrentAllocation() external view returns (address[] memory, uint256[] memory) {
        return (_currentAllocation.assets, _currentAllocation.weightsBps);
    }
}