// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IRiskLegManager} from "./interfaces/IRiskLegManager.sol";
import {AllocationSigning} from "./libraries/AllocationSigning.sol";
import {HardBounds} from "./libraries/HardBounds.sol";

import {IUniswapV3Router} from "./interfaces/IUniswapV3Router.sol";
import {OracleConsumer} from "./OracleConsumer.sol";
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
///      SCOPE: implements both the DECISION layer — signature verification,
///      hard-bounds enforcement, on-chain-derived de-risk/re-risk
///      classification (§9.5/§9.6), and the confirmation-delay state machine —
///      and the EXECUTION layer: `_executeAllocation` performs real DEX swaps
///      via IUniswapV3Router to move actual holdings toward the signed target.
///      Still explicitly NOT implemented, and tracked as follow-up work: the
///      §9.5 trigger gates (500bps deadband, 0.15 minimum variance reduction,
///      3x cost safety margin). A signed allocation that clears the hard
///      bounds executes today without those gates being consulted, so the
///      cost-churn protection §9.5 describes is NOT yet in force.
///
///      SLIPPAGE PROTECTION AND ITS LIMIT: every swap's `amountOutMinimum` is
///      derived from the OracleConsumer price, never from the pool's own spot
///      price, which would be manipulable inside the same transaction. That
///      much is sound. What is NOT validated is `maxSlippageBps` itself — see
///      the doc comment on that variable. §9.9 is explicit that the project's
///      slippage figures were derived with a V2 constant-product approximation
///      against a pool since confirmed to be Uniswap V3, and §16 item 2 / §17
///      item 2 both still list the corrected V3-native model as OPEN. Nothing
///      in this contract closes that item.
///
///      §9.8 LIQUIDITY FLOOR: signed weights sum to 10000 bps as proportions
///      among RISKY ASSETS ONLY (HardBounds.checkWeightsSumToOne is unchanged
///      and keeps that meaning). The dollar targets this contract derives from
///      them are scaled to `10000 - MIN_LIQUIDITY_FLOOR_BPS`, so at least 10%
///      of total pool value is never targeted for deployment and remains USDC
///      by construction — not by hoping the signer left room. The floor is
///      then re-asserted post-execution via HardBounds.checkLiquidityFloor, so
///      it is an enforced INVARIANT of every completed rebalance rather than
///      merely an input to the target calculation.
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
///      BOOTSTRAP EXEMPTION: on the contract's first-ever allocation (no
///      recorded previous allocation), both the max-delta check and the
///      de-risk/re-risk classification are skipped — there is no prior
///      position to measure a direction or delta against. This is
///      initialization, not a risk adjustment, and executes immediately.
///
///      CALENDAR-DAY APPROXIMATION: §9.6 specifies "5 trading days." This
///      contract uses 5 * 24 hours (calendar days) as an explicit, disclosed
///      approximation — an on-chain trading-day calendar accounting for
///      weekends/holidays across mixed equity + always-on crypto markets is
///      unspecified anywhere in the litepaper and out of scope. Flagged
///      here rather than silently treated as equivalent.
contract RiskLegManager is IRiskLegManager, Ownable, AllocationSigning, ReentrancyGuard {
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
    error SwapMetadataNotConfigured(address asset);
    error InvalidMaxSlippageBps(uint256 provided);
    error InvalidAssetDecimals(uint8 provided);
    error InvalidPoolFeeTier(uint24 provided);

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

    // -- §9.3 execution layer: DEX routing and oracle valuation --
    IUniswapV3Router public immutable swapRouter;
    OracleConsumer public immutable oracleConsumer;

    /// @dev ERC20 `decimals()` per asset, recorded at configuration time rather
    ///      than read live off the token. Two reasons: valuation must not make
    ///      an untrusted external call into an arbitrary token contract on
    ///      every price lookup, and a 0 value is used as the "not configured"
    ///      sentinel (see `_requireSwapMetadata`). CONSEQUENCE, disclosed: a
    ///      genuine 0-decimal ERC20 cannot be supported. None of the §13 MVP
    ///      universe (2-3 xStocks + 1-2 crypto, all 6/8/18 decimals) is
    ///      0-decimal, so this costs nothing today.
    mapping(address => uint8) public assetDecimals;

    /// @dev Uniswap V3 pool fee tier for this asset's USDC pair. Per-asset, not
    ///      a single global constant — §9.9 confirmed the wNVDAx pool is V3
    ///      with concentrated liquidity, and a thin equity pair will not
    ///      generally sit in the same tier as a deep crypto pair. 0 is the
    ///      "not configured" sentinel (no valid V3 tier is 0).
    mapping(address => uint24) public poolFeeTier;

    /// @notice Maximum tolerated shortfall of realized swap output below the
    ///         ORACLE-implied fair output, in bps.
    /// @dev ⚠️ UNVALIDATED PLACEHOLDER — DO NOT READ THIS AS PRODUCTION-TUNED.
    ///      The 2% default was NOT derived from X Layer pool liquidity, from
    ///      any backtest, or from any measurement. §9.9 states plainly that the
    ///      project's existing slippage figures (~1.3% at $1K, ~3.9% at $5K,
    ///      ~7.2% at $10K) came from a Uniswap V2 constant-product
    ///      approximation applied to a pool since CONFIRMED to be Uniswap V3,
    ///      for which that formula does not apply — those numbers are
    ///      "directionally indicative, not precisely validated," and §16 item 2
    ///      / §17 item 2 keep the V3-native correction OPEN.
    ///
    ///      Note what those (unvalidated) figures imply: at 2%, a $5K trade
    ///      against the measured thin pool would REVERT rather than execute at
    ///      an assumed ~3.9% cost. Whether that is correct protection or an
    ///      unusable setting is exactly what the missing V3 liquidity model
    ///      would tell us. It has not been run. Owner-settable so it can be
    ///      corrected without redeploying once §17 item 2 closes.
    uint256 public maxSlippageBps = 200;

    /// @dev Seconds added to `block.timestamp` for each swap's V3 deadline.
    ///      Not a litepaper value — a conventional short buffer, disclosed as
    ///      such. It bounds how long a submitted rebalance can sit in the
    ///      mempool before it must be resubmitted with fresh prices.
    uint256 private constant SWAP_DEADLINE_BUFFER = 300;

    /// @dev USDC is the numeraire everywhere in this contract and in
    ///      OracleConsumer.valueInUsdc, which assumes 6 decimals.
    uint8 private constant USDC_DECIMALS = 6;

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
    event AssetSwapMetadataConfigured(address indexed asset, uint8 decimals, uint24 feeTier);
    event MaxSlippageBpsUpdated(uint256 oldValue, uint256 newValue);
    event RiskServiceSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event ReRiskSignalRecorded(uint256 timestamp);
    event ReRiskSignalCleared();
    event RebalanceExecuted(address[] assets, uint256[] weightsBps, bool wasReRisk);
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 amountOut
    );

    modifier onlyVault() {
        if (msg.sender != vault) revert CallerNotVault(msg.sender);
        _;
    }

    constructor(
        address usdcAddress,
        address swapRouterAddress,
        address oracleConsumerAddress
    )
        Ownable(msg.sender)
        AllocationSigning("ParallaxRiskLegManager", "1")
    {
        usdc = IERC20(usdcAddress);
        swapRouter = IUniswapV3Router(swapRouterAddress);
        oracleConsumer = OracleConsumer(oracleConsumerAddress);
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

    /// @notice Records the ERC20 decimals and Uniswap V3 pool fee tier needed to
    ///         value and swap `asset`. Required before any allocation naming
    ///         this asset can execute — see `_requireSwapMetadata`.
    /// @dev Kept separate from `configureAsset` rather than folded into it: the
    ///      whitelist/class mapping is §9.8/§10.6 SECURITY configuration, this
    ///      is execution plumbing. Merging them would mean a fee-tier
    ///      correction and a whitelist change share one call site, and §10.6's
    ///      lookalike-token discipline is easier to audit when the whitelist
    ///      has exactly one writer.
    /// @param decimals_ Must be nonzero; 0 is this contract's "not configured"
    ///        sentinel (see `assetDecimals`).
    /// @param feeTier Must be nonzero; 0 is not a valid V3 tier and is used as
    ///        the "not configured" sentinel. Deliberately NOT restricted to the
    ///        canonical {100, 500, 3000, 10000} set — X Layer's deployment may
    ///        enable tiers this contract cannot know about, and hardcoding a
    ///        list would be exactly the kind of unvalidated assumption this
    ///        project's build discipline forbids. An unroutable tier fails
    ///        loudly at swap time rather than being silently accepted here.
    function configureAssetSwapMetadata(
        address asset,
        uint8 decimals_,
        uint24 feeTier
    ) external onlyOwner {
        if (decimals_ == 0) revert InvalidAssetDecimals(decimals_);
        if (feeTier == 0) revert InvalidPoolFeeTier(feeTier);

        assetDecimals[asset] = decimals_;
        poolFeeTier[asset] = feeTier;
        emit AssetSwapMetadataConfigured(asset, decimals_, feeTier);
    }

    /// @notice Updates the oracle-relative slippage tolerance applied to every
    ///         swap's `amountOutMinimum`.
    /// @dev The only bound enforced is the mathematically required one:
    ///      `newMaxSlippageBps` must be strictly below 10000, since at or above
    ///      it the `(BPS_DENOMINATOR - maxSlippageBps)` term would zero out the
    ///      floor (or underflow), disabling slippage protection entirely.
    ///
    ///      No TIGHTER bound is imposed, and that is a deliberate, disclosed
    ///      choice rather than an oversight: picking one (say "never above
    ///      500bps") would mean inventing a threshold with no validated basis,
    ///      which §9.9's open V3-slippage item means this project does not yet
    ///      have. The honest position is an unrestricted-but-nonzero-floor
    ///      setting plus this comment, not a fabricated safe-looking cap.
    function setMaxSlippageBps(uint256 newMaxSlippageBps) external onlyOwner {
        if (newMaxSlippageBps >= HardBounds.BPS_DENOMINATOR) {
            revert InvalidMaxSlippageBps(newMaxSlippageBps);
        }
        emit MaxSlippageBpsUpdated(maxSlippageBps, newMaxSlippageBps);
        maxSlippageBps = newMaxSlippageBps;
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

    /// @dev Total pool value in USDC terms: idle USDC plus the live
    ///      oracle-priced value of every asset the current allocation says this
    ///      contract holds.
    ///
    ///      §9.10 compliance: valuation is computed live on every call and
    ///      never cached, matching the rule §9.10 states for the rebasing
    ///      wrapper ("must call convertToAssets() live, every time — never
    ///      cached"). The same discipline is applied to all assets here.
    ///
    ///      DISCLOSED CONSEQUENCE — this couples redemption to oracle health.
    ///      `withdrawRiskLeg`, `getRiskLegValue`, and `depositRiskLeg` all route
    ///      through here, so a stale or removed feed on ANY held asset makes
    ///      those revert, not just rebalancing. §10.9 only requires that
    ///      *rebalance* revert on stale data; blocking redemption is a strictly
    ///      wider effect and is called out here rather than left implicit.
    ///      It is nonetheless the only coherent behavior available: a share's
    ///      pro-rata value is undefined while any held asset is unpriceable,
    ///      and paying out against a guessed or last-known price would move
    ///      value between noteholders. Reverting defers redemption until the
    ///      feed recovers; §9.8's "never defaults to full-liquidate or
    ///      full-deploy" is the same never-fail-open instinct. FOLLOW-UP: the
    ///      §10.10 maturity-redemption path should be reviewed against a
    ///      permanently-dead-feed scenario, which this contract has no answer
    ///      for today.
    ///
    ///      Iterating `_currentAllocation.assets` is exhaustive for assets this
    ///      contract acquired itself, since it only ever buys assets named in
    ///      an executed allocation. Tokens transferred in unsolicited are NOT
    ///      counted — deliberate: crediting arbitrary inbound tokens to pool
    ///      value would let anyone move the share price.
    function _totalPoolValue() internal view returns (uint256 total) {
        total = usdc.balanceOf(address(this));

        address[] memory assets = _currentAllocation.assets;
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 balance = IERC20(assets[i]).balanceOf(address(this));
            if (balance == 0) continue;
            total += oracleConsumer.valueInUsdc(assets[i], balance, assetDecimals[assets[i]]);
        }
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
    ///
    ///      REENTRANCY: guarded per §12's "reentrancy guards on all
    ///      external-call-adjacent functions." This function became
    ///      external-call-adjacent when swap execution landed — it now hands
    ///      control to the Uniswap router and, through it, to arbitrary ERC20
    ///      token code, in the middle of a multi-step rebalance. The window
    ///      that opens without a guard is concrete rather than theoretical:
    ///      the sell and buy passes read `balanceOf` and re-derive targets
    ///      between swaps, so a token or router callback re-entering here
    ///      would submit the next nonce against half-rebalanced balances,
    ///      with the outer call's remaining passes then executing against
    ///      state the inner call already moved. The §9.8 bounds would each
    ///      still pass in isolation while the combined effect breached them.
    ///      Being permissionless is what makes the guard necessary rather
    ///      than merely prudent: an attacker does not need the signer's
    ///      cooperation to be the caller, only a valid signed allocation,
    ///      which is public once submitted.
    function submitRebalanceTarget(
        SignedAllocation calldata allocation,
        bytes calldata signature
    ) external nonReentrant {
        HardBounds.checkArrayLengthsMatch(allocation.assets.length, allocation.weights.length);
        HardBounds.checkNotExpired(allocation.expiry);
        HardBounds.checkNonce(allocationNonce, allocation.nonce);

        bool validSignature = _verifyAllocationSignature(allocation, signature, riskServiceSigner);
        if (!validSignature) revert InvalidSignature();

        HardBounds.checkWeightsSumToOne(allocation.weights);

        // §9.8's max-delta bound is defined relative to "the previous
        // allocation" — on the vault's very first-ever submission, no
        // previous allocation exists, so there is nothing for the 20pp cap
        // to meaningfully constrain against. Skip it ONLY in this bootstrap
        // case; every subsequent submission (including one introducing a
        // brand-new asset never seen before) is checked normally, since a
        // 0-to-X jump for a newly-added asset in an otherwise-established
        // portfolio IS exactly the kind of concentration risk the cap exists
        // to prevent.
        bool isBootstrap = _currentAllocation.assets.length == 0;

        for (uint256 i = 0; i < allocation.assets.length; i++) {
            address asset = allocation.assets[i];
            HardBounds.checkWhitelisted(asset, assetWhitelisted);
            HardBounds.checkConcentrationCap(asset, allocation.weights[i]);

            if (!isBootstrap) {
                uint256 previousWeight = _weightOf(asset);
                HardBounds.checkMaxDelta(asset, previousWeight, allocation.weights[i]);
            }
        }

        // §9.8's max-delta bound applied to assets the new allocation OMITS.
        //
        // The loop above only sees assets NAMED in the submission, which left a
        // hole: omitting an asset drops its weight to zero implicitly, and an
        // implicit drop was never delta-checked. Verified before fixing, not
        // assumed — a baseline holding btc at 4000 bps could be replaced by an
        // allocation that simply left btc out, moving it 40pp (double the cap)
        // in one submission and fully liquidating the position, with no revert.
        //
        // §9.8 states the bound over "any asset's weight," not "any submitted
        // asset's weight," so omission was never exempt by the spec — the
        // exemption was an artifact of iterating only the incoming array. This
        // makes omission behave identically to an explicit 0-bps submission,
        // which the loop above already bounded correctly. It closes an
        // inconsistency rather than adding a restriction: the same portfolio
        // change was already blocked when written one way and allowed when
        // written another.
        //
        // CONSEQUENCE, stated because it is a real behavior change: a position
        // above 20% can no longer be exited in a single submission by any route.
        // It must be wound down across submissions (e.g. 6000 -> 4000 -> 2000 ->
        // omitted), each of which independently satisfies every bound. That is
        // exactly the constraint §9.8 already imposed on every other weight
        // change, and the §9.6 confirmation delay does not apply here since
        // reducing exposure classifies as a de-risk.
        //
        // Naturally a no-op on bootstrap: `_currentAllocation.assets` is empty,
        // so there is no prior weight to measure against.
        for (uint256 i = 0; i < _currentAllocation.assets.length; i++) {
            address heldAsset = _currentAllocation.assets[i];
            if (_containsAsset(allocation.assets, heldAsset)) continue;

            HardBounds.checkMaxDelta(heldAsset, _currentAllocation.weightsBps[i], 0);
        }

        allocationNonce++;

        if (isBootstrap) {
            // First-ever allocation: initialization, not a risk adjustment.
            // No prior position exists to classify a direction against, so
            // this executes immediately regardless of what it contains
            // (subject to the bounds already checked above).
            if (pendingReRiskSignal.exists) {
                emit ReRiskSignalCleared();
                delete pendingReRiskSignal;
            }
            _executeAllocation(allocation.assets, allocation.weights, false);
            return;
        }

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

        if (!pendingReRiskSignal.exists) {
            pendingReRiskSignal = PendingSignal({exists: true, firstSeenAt: block.timestamp});
            emit ReRiskSignalRecorded(block.timestamp);
            return;
        }

        if (block.timestamp - pendingReRiskSignal.firstSeenAt >= RERISK_CONFIRMATION_DELAY) {
            delete pendingReRiskSignal;
            _executeAllocation(allocation.assets, allocation.weights, true);
            return;
        }
    }

    /// @dev Two-pass rebalancer: sell every over-target holding into USDC, then
    ///      buy every under-target holding out of USDC.
    ///
    ///      WHY SELL-THEN-BUY, and why `totalValue` is recomputed between the
    ///      passes: the buy pass can only spend USDC that exists, so it must
    ///      run after the sells have raised it. And realized sell output may
    ///      land anywhere from `amountOutMinimum` up to the oracle-fair amount,
    ///      so total pool value after the sell pass is a MEASURED quantity, not
    ///      the pre-sell figure. Sizing buys off the stale pre-sell total would
    ///      target dollars the pool no longer has.
    function _executeAllocation(
        address[] calldata assets,
        uint256[] calldata weightsBps,
        bool wasReRisk
    ) internal {
        // Validated upfront, before any swap, so a rebalance can never be left
        // half-executed holding an asset this contract cannot value or unwind.
        for (uint256 i = 0; i < assets.length; i++) {
            _requireSwapMetadata(assets[i]);
        }

        uint256 totalValue = _totalPoolValue();

        // An empty pool has nothing to deploy and nothing to protect. Both
        // passes and the floor assertion are skipped rather than run against
        // zero — the floor is a FRACTION of total value, so it is undefined
        // here, and computing it would divide by zero.
        //
        // Recording a target allocation before any capital has arrived is
        // legitimate and already-tested behavior (the bootstrap path from the
        // prior commit): the vault records intent, deposits follow. Reverting
        // instead would break that. NOTE the resulting gap, stated plainly:
        // between such a bootstrap and the first rebalance AFTER a deposit,
        // holdings sit in USDC and do not match the recorded target. Nothing
        // in the litepaper specifies auto-deployment on deposit, and inventing
        // it here would be scope creep; §9.5's trigger gates (deferred) are
        // where that decision belongs.
        if (totalValue > 0) {
            _sellOverweight(assets, weightsBps, totalValue);

            totalValue = _totalPoolValue();

            _buyUnderweight(assets, weightsBps, totalValue);
        }

        _currentAllocation.assets = assets;
        _currentAllocation.weightsBps = weightsBps;

        // §9.8 defense-in-depth. Target scaling above already reserves the
        // floor, so this should never fire; it is asserted anyway because the
        // reserve is only as good as the arithmetic that produced it, and
        // realized slippage on the sell pass eats into total value in a way the
        // pre-swap calculation cannot fully anticipate. Reverting the WHOLE
        // rebalance is the correct response: §9.8 lists the floor as a hard
        // bound, and hard bounds are not advisory.
        //
        // Recomputed after `_currentAllocation` is updated, so it values the
        // NEW asset set — the set actually held post-execution.
        uint256 finalTotalValue = _totalPoolValue();
        if (finalTotalValue > 0) {
            uint256 usdcBps = (usdc.balanceOf(address(this)) * HardBounds.BPS_DENOMINATOR) / finalTotalValue;
            HardBounds.checkLiquidityFloor(usdcBps);
        }

        emit RebalanceExecuted(assets, weightsBps, wasReRisk);
    }

    /// @dev Sell pass. Iterates the assets currently HELD (the previous
    ///      allocation), not the incoming target set — that is what makes an
    ///      asset dropped from the target liquidate fully rather than linger:
    ///      `_targetWeightOf` returns 0 for it, so its entire balance is
    ///      excess. Assets newly introduced by the target hold a zero balance
    ///      and have nothing to sell, so iterating the held set loses nothing.
    function _sellOverweight(
        address[] calldata targetAssets,
        uint256[] calldata targetWeightsBps,
        uint256 totalValue
    ) private {
        uint256 deployableValue = _deployableValue(totalValue);

        address[] memory heldAssets = _currentAllocation.assets;
        for (uint256 i = 0; i < heldAssets.length; i++) {
            address asset = heldAssets[i];

            uint256 balance = IERC20(asset).balanceOf(address(this));
            if (balance == 0) continue;

            uint8 assetTokenDecimals = assetDecimals[asset];
            uint256 currentValueUsdc = oracleConsumer.valueInUsdc(asset, balance, assetTokenDecimals);

            uint256 targetValueUsdc = (deployableValue *
                _targetWeightOf(asset, targetAssets, targetWeightsBps)) / HardBounds.BPS_DENOMINATOR;

            if (currentValueUsdc <= targetValueUsdc) continue;

            uint256 excessValueUsdc = currentValueUsdc - targetValueUsdc;

            // Sized proportionally against the TOKEN balance rather than by
            // running `excessValueUsdc` back through an inverse-price
            // conversion. Two properties this ordering buys, both checked:
            //   - No division by zero. Reaching this line requires
            //     currentValueUsdc > targetValueUsdc >= 0, so currentValueUsdc
            //     is strictly positive; it can never be the zero denominator.
            //   - Cannot oversell. excessValueUsdc < currentValueUsdc, so the
            //     quotient is strictly less than `balance` — no clamp needed,
            //     whereas the inverse-price route could round above `balance`
            //     and revert on transfer.
            // Multiplication precedes division, so precision is lost only in
            // the final truncation, and truncation UNDER-sells by at most one
            // token unit — the safe direction, since overselling would breach
            // the target on the low side.
            uint256 amountToSell = (balance * excessValueUsdc) / currentValueUsdc;
            if (amountToSell == 0) continue;

            _swap(asset, address(usdc), amountToSell, assetTokenDecimals, USDC_DECIMALS);
        }
    }

    /// @dev Buy pass. Iterates the incoming target set, spending idle USDC into
    ///      every asset sitting below target.
    function _buyUnderweight(
        address[] calldata targetAssets,
        uint256[] calldata targetWeightsBps,
        uint256 totalValue
    ) private {
        uint256 deployableValue = _deployableValue(totalValue);

        // The reserve, in absolute USDC rather than as a ratio. Every buy is
        // capped so the balance cannot be drawn below this line, which is what
        // makes the §9.8 floor hold BY CONSTRUCTION rather than approximately.
        //
        // Capping at the reserve instead of at the whole USDC balance is not
        // cosmetic — capping at the balance is provably insufficient. In exact
        // arithmetic the deficits sum to `deployableValue - heldValue`, which
        // always leaves the reserve untouched. Integer truncation breaks that
        // identity: an asset whose target is not exactly representable in its
        // own decimals reads back BELOW what was actually spent acquiring it
        // (a 6-decimal token at $550 loses up to 549 USDC-units per valuation),
        // so its computed deficit over-states the true shortfall and the
        // surplus is drawn straight out of the reserve. Measured, not
        // hypothesized: a 3-asset rebalance including a 6-decimal asset landed
        // at 999 bps against a 1000 bps floor, reverting a legitimate
        // rebalance on nothing but rounding.
        //
        // With this cap, `usdcFinal >= reserveFloor = totalValue * 1000 / 10000`
        // holds regardless of truncation direction, and total value can only
        // fall through the buy pass (truncation and slippage both lose value),
        // so the post-execution ratio is >= the floor by construction.
        //
        // ORDERING, restated honestly now that the cap CAN bind: when it binds
        // it does so only for rounding-dust amounts, so the last asset in
        // `targetAssets` may be short-filled by a few USDC-units. That is a
        // bounded, dust-scale order dependence, not a material one — a signer
        // cannot meaningfully bias fills by reordering.
        uint256 reserveFloor = (totalValue * HardBounds.MIN_LIQUIDITY_FLOOR_BPS) /
            HardBounds.BPS_DENOMINATOR;

        for (uint256 i = 0; i < targetAssets.length; i++) {
            address asset = targetAssets[i];
            uint8 assetTokenDecimals = assetDecimals[asset];

            uint256 balance = IERC20(asset).balanceOf(address(this));
            uint256 currentValueUsdc = balance == 0
                ? 0
                : oracleConsumer.valueInUsdc(asset, balance, assetTokenDecimals);

            uint256 targetValueUsdc = (deployableValue * targetWeightsBps[i]) / HardBounds.BPS_DENOMINATOR;
            if (currentValueUsdc >= targetValueUsdc) continue;

            uint256 deficitUsdc = targetValueUsdc - currentValueUsdc;

            uint256 usdcOnHand = usdc.balanceOf(address(this));
            uint256 spendable = usdcOnHand > reserveFloor ? usdcOnHand - reserveFloor : 0;
            uint256 amountIn = deficitUsdc > spendable ? spendable : deficitUsdc;
            if (amountIn == 0) continue;

            _swap(address(usdc), asset, amountIn, USDC_DECIMALS, assetTokenDecimals);
        }
    }

    /// @dev §9.8 liquidity floor, applied as a RESERVE on the dollar targets.
    ///      Signed weights are proportions among risky assets only and sum to
    ///      10000 bps (HardBounds.checkWeightsSumToOne, unchanged), so scaling
    ///      the pool value they are applied to is what holds the floor back —
    ///      at least MIN_LIQUIDITY_FLOOR_BPS of total value is never targeted
    ///      for deployment and therefore stays USDC by construction.
    function _deployableValue(uint256 totalValue) private pure returns (uint256) {
        return (totalValue * (HardBounds.BPS_DENOMINATOR - HardBounds.MIN_LIQUIDITY_FLOOR_BPS)) /
            HardBounds.BPS_DENOMINATOR;
    }

    /// @dev Executes one swap with an ORACLE-derived minimum output.
    ///
    ///      The pool's own spot price is never consulted to set the floor. That
    ///      is the whole point: a spot-derived `amountOutMinimum` can be moved
    ///      by the same transaction that trades against it, so it protects
    ///      nothing. An independently-priced floor means a manipulated pool
    ///      fails the minimum and the swap reverts.
    ///
    ///      Both `valueInUsdc` and `_usdcValueToTokenAmount` truncate, and the
    ///      slippage multiplication then truncates again — every rounding step
    ///      pushes `amountOutMinimum` DOWN. That is the correct direction: a
    ///      minimum rounded UP could exceed what an honest, fairly-priced pool
    ///      can deliver, reverting good trades.
    function _swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint8 tokenInDecimals,
        uint8 tokenOutDecimals
    ) private returns (uint256 amountOut) {
        bool sellingForUsdc = tokenOut == address(usdc);

        uint256 expectedAmountOut;
        if (sellingForUsdc) {
            expectedAmountOut = oracleConsumer.valueInUsdc(tokenIn, amountIn, tokenInDecimals);
        } else {
            // `amountIn` is already denominated in USDC, so it IS its own USDC
            // value — no forward conversion needed, only the inverse.
            expectedAmountOut = _usdcValueToTokenAmount(tokenOut, amountIn, tokenOutDecimals);
        }

        // A trade the oracle expects to yield ZERO output units is refused
        // outright. This is not a gas optimization — it closes a hole. The
        // slippage floor is a FRACTION of the expected output, so an expected
        // output of 0 yields `amountOutMinimum == 0`, and a swap with a zero
        // minimum has no slippage protection whatsoever: the router could
        // accept the input and return nothing while still satisfying the
        // minimum. Such trades are pure loss and are the one case where this
        // contract's protection would otherwise be vacuous rather than merely
        // loose.
        //
        // Reachable with real numbers, not just in theory: buying a 6-decimal
        // asset priced at $550 with less than 550 USDC-units of input rounds the
        // expected output to zero, which is exactly the dust-sized deficit a
        // re-submitted allocation produces when a target is not exactly
        // representable in the asset's own decimals.
        //
        // SCOPE, stated precisely so this is not over-read: this guarantees no
        // swap executes on a zero expected output. It does NOT guarantee
        // `amountOutMinimum > 0` at every setting — an extreme `maxSlippageBps`
        // (say 9999) still truncates a small positive expectation to a zero
        // floor. Bounding that would mean inventing a minimum trade size, and
        // §9.5's deadband is the litepaper's own answer to dust churn, deferred
        // as follow-up. Not invented here.
        if (expectedAmountOut == 0) return 0;

        uint256 amountOutMinimum = (expectedAmountOut *
            (HardBounds.BPS_DENOMINATOR - maxSlippageBps)) / HardBounds.BPS_DENOMINATOR;

        // The fee tier belongs to the asset/USDC pair, so it is always keyed by
        // whichever side is not USDC.
        uint24 feeTier = sellingForUsdc ? poolFeeTier[tokenIn] : poolFeeTier[tokenOut];

        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);

        amountOut = swapRouter.exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: feeTier,
                recipient: address(this),
                deadline: block.timestamp + SWAP_DEADLINE_BUFFER,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        // Reset rather than leave a standing allowance. A router that consumed
        // less than `amountIn` would otherwise leave a live approval behind.
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);

        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOutMinimum, amountOut);
    }

    /// @dev Exact algebraic inverse of OracleConsumer.valueInUsdc: given a USDC
    ///      value, the token amount that values to it at the current oracle
    ///      price. Used only to derive an EXPECTED output before the slippage
    ///      tolerance is applied, never to move funds directly.
    ///
    ///      No division by zero is reachable: `getPrice` reverts on any
    ///      non-positive answer, so `priceUint` is strictly positive, and the
    ///      `10 ** n` factor is at least 1. Division is last in the
    ///      exponent >= 6 branch so precision survives to the final truncation.
    function _usdcValueToTokenAmount(
        address asset,
        uint256 usdcValue,
        uint8 assetTokenDecimals
    ) private view returns (uint256) {
        int256 price = oracleConsumer.getPrice(asset); // staleness-checked, §10.9
        uint8 feedDecimals = oracleConsumer.decimals(asset);

        uint256 priceUint = uint256(price);
        uint256 exponent = uint256(assetTokenDecimals) + uint256(feedDecimals);

        if (exponent >= 6) {
            return (usdcValue * (10 ** (exponent - 6))) / priceUint;
        } else {
            return usdcValue / (priceUint * (10 ** (6 - exponent)));
        }
    }

    /// @dev Both sentinels checked together: an asset is only swappable once it
    ///      has BOTH a decimals value (to price it) and a pool fee tier (to
    ///      route it). Failing here, before any transfer, is the difference
    ///      between a clean revert and a swap attempted against a nonexistent
    ///      fee-tier-0 pool.
    function _requireSwapMetadata(address asset) private view {
        if (assetDecimals[asset] == 0 || poolFeeTier[asset] == 0) {
            revert SwapMetadataNotConfigured(asset);
        }
    }

    /// @dev Weight the incoming target assigns to `asset`, or 0 when the target
    ///      omits it entirely — which is what drives full liquidation of a
    ///      dropped asset in the sell pass.
    function _targetWeightOf(
        address asset,
        address[] calldata targetAssets,
        uint256[] calldata targetWeightsBps
    ) private pure returns (uint256) {
        for (uint256 i = 0; i < targetAssets.length; i++) {
            if (targetAssets[i] == asset) return targetWeightsBps[i];
        }
        return 0;
    }

    /// @dev Membership test, deliberately separate from `_targetWeightOf`.
    ///      That function cannot answer this question: it returns 0 both for an
    ///      asset the allocation omits and for one it explicitly submits at 0
    ///      bps. The §9.8 omission check needs to tell those apart, since the
    ///      explicit-0 case is already bounded by the main loop and re-checking
    ///      it would be redundant.
    function _containsAsset(address[] calldata assets, address asset) private pure returns (bool) {
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == asset) return true;
        }
        return false;
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

    /// @notice Total pool value in USDC terms — idle USDC plus the live
    ///         oracle-priced value of every holding.
    /// @dev Exposes `_totalPoolValue()` for §10.7 share-accounting tests and for
    ///      the §12 frontend's rebalance activity feed. Reverts under the same
    ///      oracle conditions as the internal function; see its DISCLOSED
    ///      CONSEQUENCE note.
    function totalPoolValue() external view returns (uint256) {
        return _totalPoolValue();
    }
}