// Parallax deployment config TEMPLATE.
//
//   cp scripts/deploy.config.example.js scripts/deploy.config.js
//
// then fill in every field marked NOT YET VERIFIED. scripts/deploy.js refuses
// to deploy while any of them is null and prints the full list of what is
// missing, so this file cannot be used as-is by accident.
//
// ---------------------------------------------------------------------------
// WHY SO MUCH OF THIS IS null
// ---------------------------------------------------------------------------
// This project's standing rule: a value is either confirmed against a primary
// source or it is explicitly absent. Never a plausible-looking placeholder.
// offchain/config/asset_universe.yaml states the reasoning for addresses
// specifically, and it applies to every field here:
//
//     "an unverified address here is worse than an explicit gap, because it
//      would silently pass validation and route real funds."
//
// So the nulls below are not laziness or TODO debt — they are the accurate
// record of what has and has not been researched. Filling one in with a
// guess would defeat the validation in deploy.js, which exists precisely to
// stop that.
//
// DO NOT DEPLOY TO A REAL NETWORK WITH ANY FIELD BELOW STILL null.

module.exports = {
  // Optional guard: deploy.js aborts if the connected chain doesn't match.
  // Chain IDs are the ones already recorded in hardhat.config.js, sourced from
  // X Layer's network-information documentation (linked in that file).
  network: {
    name: "xlayerTestnet",
    chainId: 1952, // 196 = X Layer mainnet, 1952 = X Layer testnet
  },

  // -------------------------------------------------------------------------
  // External dependencies
  // -------------------------------------------------------------------------

  /// USDC token on the target network.
  /// NOT YET VERIFIED — no X Layer USDC address has been confirmed on-chain in
  /// this project. See docs/parallax_litepaper.md §7 (deposits are USDC).
  ///
  /// ALSO NOTE, and confirm at the same time: the contracts hardcode USDC at 6
  /// decimals (RiskLegManager.USDC_DECIMALS, and OracleConsumer.valueInUsdc's
  /// entire scaling path). If X Layer's canonical USDC is not 6 decimals, this
  /// is a CODE change, not a config change.
  /// Do not deploy to a real network with this field null.
  usdc: null,

  /// Aave v3 Pool on the target network.
  /// NOT YET VERIFIED — needs confirming against Aave's official X Layer
  /// deployment registry or an X Layer block explorer. §6 specifies the safe
  /// leg is "a real Aave lending position"; §4 records Aave v3.6 as live on X
  /// Layer since March 2026, but no address was captured.
  /// Do not deploy to a real network with this field null.
  aavePool: null,

  /// Uniswap V3 SwapRouter on the target network.
  /// NOT YET VERIFIED — §9.9 confirms the target wNVDAx pool IS a Uniswap V3
  /// pool (concentrated liquidity), so a V3 router is the right integration,
  /// but the router's own address was never recorded.
  /// Do not deploy to a real network with this field null.
  uniswapV3SwapRouter: null,

  // -------------------------------------------------------------------------
  // Protocol roles
  // -------------------------------------------------------------------------

  /// Address whose EIP-712 signatures RiskLegManager will accept for rebalance
  /// allocations (§9.8).
  /// OPERATOR DECISION, not a research item — but still must be set
  /// deliberately. MVP is a single EOA; §9.8/§17 anticipate upgrading this to
  /// a Gnosis Safe later, which needs no interface change (AllocationSigning
  /// verifies via SignatureChecker, which handles ERC-1271).
  /// Do not deploy to a real network with this field null.
  riskServiceSigner: null,

  // -------------------------------------------------------------------------
  // ParallaxVault tuning parameters
  // -------------------------------------------------------------------------
  //
  // All USDC amounts are RAW BASE UNITS (no implicit decimal conversion in
  // deploy.js — an off-by-1e6 in a deposit cap is exactly the kind of error a
  // hidden conversion causes).
  vault: {
    /// §12 Security: "Hard deposit cap for hackathon scope, disclosed in UI."
    /// NOT YET SPECIFIED — the litepaper mandates a cap but names no value.
    /// Example shape: "1000000000000" would be 1,000,000 USDC at 6 decimals.
    /// Do not deploy to a real network with this field null.
    depositCap: null,

    /// §9.1 `r`: the conservative, contract-enforced minimum Aave APY used to
    /// size the safe leg, in bps.
    /// NOT YET VERIFIED — §9.1's worked example uses 8% but labels it
    /// "illustrative"; §9.1 requires a value "never more aggressive than this
    /// floor." Picking it requires real Aave X Layer USDC supply-rate history,
    /// which has not been gathered. This is the single most consequential
    /// number in the product: set it too high and the safe leg is undersized
    /// and the principal guarantee fails.
    /// Do not deploy to a real network with this field null.
    conservativeRateBps: null,

    /// Minimum deposit, raw base units.
    /// NOT YET SPECIFIED — no litepaper value. A floor exists mainly so dust
    /// notes can't be issued; §9.1's economics also imply a deposit small
    /// enough makes the risk leg negligible (cf. §13's 7-day-term analysis
    /// yielding a 0.15% risk leg).
    /// Do not deploy to a real network with this field null.
    minimumDeposit: null,

    /// §9.7 early-exit penalty, bps of the RISK LEG only (never the safe leg).
    /// NOT YET SPECIFIED — §9.7 says MVP uses "simple, disclosed penalty-based
    /// pricing (not yet formula-specified)" and §16 item 4 / §17 item 4 both
    /// track this as an OPEN item blocking frontend work. ParallaxVault caps it
    /// at 5000 bps regardless of what is set here.
    /// Do not deploy to a real network with this field null.
    earlyExitPenaltyBps: null,
  },

  // -------------------------------------------------------------------------
  // Risk-leg asset universe (§13: 2-3 xStocks + 1-2 crypto)
  // -------------------------------------------------------------------------
  //
  // Order mirrors offchain/config/asset_universe.yaml, which is the source of
  // truth for ticker/class/address. Keep the two in sync — the off-chain §9.3
  // solver and the on-chain whitelist must describe the same universe.
  //
  // `decimals` is null for ALL FIVE assets, including the three whose addresses
  // are verified. This is deliberate and worth stating plainly: no decimals()
  // call is recorded anywhere in this project — not in asset_universe.yaml, not
  // in scripts/verify_wrapper.js's ABI, not in the litepaper. 18 is strongly
  // IMPLIED for the three xStocks by the §9.10 readings (convertToAssets(1e18)
  // returning ~1.0057e18 for wSPYx; totalSupply ~688.95e18 for wTSLAx), but
  // implied is not confirmed, and RiskLegManager stores this value permanently
  // to price every holding. One decimals() call per asset closes it.
  assets: [
    {
      ticker: "BTC-USD",
      class: "crypto",
      /// NOT YET VERIFIED. asset_universe.yaml carries
      /// 0xb7c00000bcdeef966b20b3d884b98e64d2b06b4f for this ticker, but unlike
      /// wNVDAx/wTSLAx/wSPYx it has NO inline verification record, it is absent
      /// from scripts/verify_wrapper.js, and no on-chain confirmation exists in
      /// this repo. Commit 04011c0's message claims all five were verified; the
      /// file's own contents document only three. Confirm on-chain before use.
      /// Do not deploy to a real network with this field null.
      address: null,
      /// NOT YET VERIFIED — see the note above this array.
      decimals: null,
      /// NOT YET VERIFIED — Uniswap V3 pool fee tier for this asset's USDC
      /// pair. §9.9 confirms V3 pools but records no tier. Must be a tier that
      /// actually exists, with real liquidity, or swaps revert.
      poolFeeTier: null,
      /// NOT YET VERIFIED — see §10.9 and the note at the end of this file
      /// about Data Feeds vs Data Streams.
      chainlinkAggregator: null,
      /// NOT YET VERIFIED — §10.9 requires "a defined freshness threshold" but
      /// names no value. Should reflect this feed's real update cadence.
      maxStalenessSeconds: null,
    },
    {
      ticker: "ETH-USD",
      class: "crypto",
      /// NOT YET VERIFIED. asset_universe.yaml carries
      /// 0xe7b000003a45145decf8a28fc755ad5ec5ea025a; same gap as BTC-USD above
      /// — no verification record anywhere in this repo.
      /// Do not deploy to a real network with this field null.
      address: null,
      decimals: null, // NOT YET VERIFIED
      poolFeeTier: null, // NOT YET VERIFIED — §9.9
      chainlinkAggregator: null, // NOT YET VERIFIED — §10.9
      maxStalenessSeconds: null, // NOT YET VERIFIED — §10.9
    },
    {
      ticker: "wNVDAx",
      class: "equity",
      // VERIFIED per §9.10: asset(), totalAssets()/totalSupply(), and
      // convertToAssets(1e18) all confirmed ERC-4626-style wrapper behavior
      // with a live accruing exchange rate (~1.0009).
      address: "0xa8ddb5cd96b5222afe198316e9a57caa642850d5",
      decimals: null, // NOT YET VERIFIED — see note above this array
      poolFeeTier: null, // NOT YET VERIFIED — §9.9. This is the pool whose
                          // thin liquidity §9.9/§10.6 specifically flag.
      chainlinkAggregator: null, // NOT YET VERIFIED — §10.9
      maxStalenessSeconds: null, // NOT YET VERIFIED — §10.9. An equity feed
                                  // behaves differently while the underlying
                                  // market is closed; do not reuse a crypto
                                  // asset's threshold here.
    },
    {
      ticker: "wTSLAx",
      class: "equity",
      // VERIFIED 2026-08-15 via scripts/verify_wrapper.js against
      // xlayerrpc.okx.com: name() "Wrapped Tesla xStock", symbol() "wTSLAx",
      // asset() 0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0,
      // totalAssets() == totalSupply() == 688952071927489864782.
      // CAVEAT recorded in asset_universe.yaml: exchange rate is exactly 1.0,
      // so accrual has never been observed on this wrapper — a weaker
      // confirmation than wSPYx/wNVDAx. Re-verify before mainnet.
      address: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171",
      decimals: null, // NOT YET VERIFIED — see note above this array
      poolFeeTier: null, // NOT YET VERIFIED — §9.9
      chainlinkAggregator: null, // NOT YET VERIFIED — §10.9
      maxStalenessSeconds: null, // NOT YET VERIFIED — §10.9
    },
    {
      ticker: "wSPYx",
      class: "equity",
      // VERIFIED 2026-08-15 via scripts/verify_wrapper.js against
      // xlayerrpc.okx.com: name() "Wrapped SP500 xStock", symbol() "wSPYx",
      // asset() 0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48,
      // convertToAssets(1e18) = 1005714560286254000 -> ~1.005714, confirming
      // live rebasing-wrapper accrual.
      address: "0xe7e553cd128f0011777323a0b44a7b96ea1cb540",
      decimals: null, // NOT YET VERIFIED — see note above this array
      poolFeeTier: null, // NOT YET VERIFIED — §9.9
      chainlinkAggregator: null, // NOT YET VERIFIED — §10.9
      maxStalenessSeconds: null, // NOT YET VERIFIED — §10.9
    },
  ],
};

// ---------------------------------------------------------------------------
// OPEN QUESTION ON THE ORACLE INTEGRATION — read before researching the
// chainlinkAggregator fields above
// ---------------------------------------------------------------------------
//
// OracleConsumer is built against IChainlinkAggregator.latestRoundData(), which
// is the PUSH-based Chainlink Data Feeds interface (AggregatorV3Interface).
// §4 of the litepaper records "Chainlink Data Streams (June 2026)" as the X
// Layer prerequisite that went live, and §1 cites "sub-second Chainlink
// equity/crypto pricing."
//
// Data Streams and Data Feeds are DIFFERENT products: Data Streams is
// pull-based, delivering signed reports that a consumer verifies on-chain, and
// it does not expose per-asset aggregator contracts with latestRoundData().
// "Sub-second" pricing in particular points at Streams, not Feeds.
//
// So there may be no aggregator address to put in these fields at all. Resolve
// which product X Layer actually offers for these five assets BEFORE hunting
// for addresses. If it is Streams-only, OracleConsumer needs a different
// interface and §10.9's staleness check has to be re-expressed against report
// timestamps — a code change, not a config change.
