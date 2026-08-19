// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IChainlinkAggregator} from "./interfaces/IChainlinkAggregator.sol";

/// @title OracleConsumer
/// @notice Chainlink price reads with staleness protection, per
///         docs/parallax_litepaper.md §9.9, §10.9, §9.8.
/// @dev Separated from SafeLegManager/RiskLegManager because §10.9's staleness
///      check is a cross-cutting concern both leg managers need — one
///      implementation, one freshness threshold, no risk of the two managers
///      drifting to different staleness definitions over time.
///
///      §10.9 STATUS: this contract is the "not yet implemented" oracle
///      staleness protection flagged in §16 item 3 and §17 item 3 as an open
///      launch-readiness item. This commit CLOSES that gap — before this,
///      staleness checking existed only in the litepaper's design (§9.8) with
///      no code. After this, `getPrice()` reverts on stale data by
///      construction; there is no code path that returns a stale price
///      silently. §17 item 3 should be marked resolved once this is reviewed
///      and wired into RiskLegManager's rebalance logic (not yet done — see
///      the RiskLegManager scope note from the prior commit).
contract OracleConsumer is Ownable {
    error ZeroAggregatorAddress();
    error AssetNotConfigured(address asset);
    error StalePrice(address asset, uint256 updatedAt, uint256 blockTimestamp, uint256 maxStaleness);
    error NonPositivePrice(address asset, int256 answer);
    error InvalidMaxStaleness(uint256 provided);

    struct FeedConfig {
        IChainlinkAggregator aggregator;
        uint256 maxStalenessSeconds;
    }

    mapping(address => FeedConfig) public feeds;

    event FeedConfigured(address indexed asset, address indexed aggregator, uint256 maxStalenessSeconds);
    event FeedRemoved(address indexed asset);

    constructor() Ownable(msg.sender) {}

    /// @notice Registers or updates the Chainlink feed for an asset.
    /// @dev Address-keyed, per §10.6's "asset whitelist is hardcoded by
    ///      address, never resolved by ticker symbol" discipline — this
    ///      mapping is keyed by the asset's own token contract address, not a
    ///      string ticker, so there is no symbol-resolution step anywhere in
    ///      the price-lookup path.
    /// @param maxStalenessSeconds Per-feed threshold, not a single global
    ///      constant — different asset classes have different Chainlink update
    ///      cadences (equity feeds during market-closed hours behave
    ///      differently than always-on crypto feeds), so this is deliberately
    ///      configurable per asset rather than one value assumed to fit both
    ///      §9.9's crypto/equity asset universe uniformly.
    function configureFeed(
        address asset,
        address aggregatorAddress,
        uint256 maxStalenessSeconds
    ) external onlyOwner {
        if (aggregatorAddress == address(0)) revert ZeroAggregatorAddress();
        if (maxStalenessSeconds == 0) revert InvalidMaxStaleness(maxStalenessSeconds);

        feeds[asset] = FeedConfig({
            aggregator: IChainlinkAggregator(aggregatorAddress),
            maxStalenessSeconds: maxStalenessSeconds
        });

        emit FeedConfigured(asset, aggregatorAddress, maxStalenessSeconds);
    }

    function removeFeed(address asset) external onlyOwner {
        delete feeds[asset];
        emit FeedRemoved(asset);
    }

    /// @notice Returns the latest price for `asset`, reverting if the feed is
    ///         stale, unconfigured, or returns a non-positive answer.
    /// @dev §10.9: "Chainlink feed returns a stale timestamp -> rebalance must
    ///      revert, not execute on stale data." This is the single enforcement
    ///      point — any caller (RiskLegManager's rebalance logic, safe-leg
    ///      rate lookups if the AI-forecast path is ever built) gets the same
    ///      guarantee by construction, not by remembering to check separately.
    ///
    ///      §9.8's "Risk-service unavailability/compromise: contract holds
    ///      last valid allocation, accepts no new instructions" principle
    ///      extends naturally here: a revert on stale price means the CALLER
    ///      (e.g. RiskLegManager.executeRebalance) simply fails to execute
    ///      that transaction — it does not fall back to a stale or default
    ///      price. Never-fail-open is the design, matching §9.8's explicit
    ///      instruction that unavailability must never trigger a full-liquidate
    ///      or full-deploy default.
    /// @return price The latest answer, in the aggregator's native decimals
    ///         (call `decimals(asset)` to interpret).
    function getPrice(address asset) external view returns (int256 price) {
        FeedConfig memory config = feeds[asset];
        if (address(config.aggregator) == address(0)) {
            revert AssetNotConfigured(asset);
        }

        (, int256 answer, , uint256 updatedAt, ) = config.aggregator.latestRoundData();

        if (answer <= 0) {
            revert NonPositivePrice(asset, answer);
        }

        if (block.timestamp - updatedAt > config.maxStalenessSeconds) {
            revert StalePrice(asset, updatedAt, block.timestamp, config.maxStalenessSeconds);
        }

        return answer;
    }

    /// @notice Returns the configured aggregator's decimals for `asset`,
    ///         needed by callers to correctly scale getPrice()'s return value.
    function decimals(address asset) external view returns (uint8) {
        FeedConfig memory config = feeds[asset];
        if (address(config.aggregator) == address(0)) {
            revert AssetNotConfigured(asset);
        }
        return config.aggregator.decimals();
    }

    /// @notice Converts a token amount into its USDC-equivalent value using
    ///         this asset's configured price feed, accounting for both the
    ///         feed's own decimals and the token's own decimals.
    /// @dev USDC is assumed 6 decimals (true for all supported USDC
    ///      deployments on X Layer per docs/parallax_litepaper.md). Reverts
    ///      under the same staleness/non-positive-price conditions as
    ///      getPrice(), since it calls getPrice() internally — never returns
    ///      a value derived from stale data.
    ///
    ///      ROUNDING: integer division truncates, so the returned value is
    ///      rounded DOWN (never up). Callers using this to derive a slippage
    ///      floor (RiskLegManager._swap) therefore get a conservative
    ///      under-estimate of value, which is the safe direction — an
    ///      over-estimate would set an `amountOutMinimum` the pool cannot
    ///      satisfy even on an honest, fairly-priced trade.
    /// @param assetTokenDecimals The ERC20 `decimals()` of `asset`, supplied by
    ///        the caller rather than read from the token — this contract holds
    ///        no token-metadata registry, and reading `decimals()` off an
    ///        arbitrary address would add an untrusted external call to the
    ///        price path.
    function valueInUsdc(
        address asset,
        uint256 amount,
        uint8 assetTokenDecimals
    ) external view returns (uint256) {
        int256 price = this.getPrice(asset); // staleness-checked, §10.9
        uint8 feedDecimals = this.decimals(asset);

        // amount (assetTokenDecimals) * price (feedDecimals) -> USDC (6 decimals)
        // = amount * price / 10^(assetTokenDecimals + feedDecimals - 6)
        uint256 priceUint = uint256(price);
        uint256 numerator = amount * priceUint;
        uint256 exponent = uint256(assetTokenDecimals) + uint256(feedDecimals);

        if (exponent >= 6) {
            return numerator / (10 ** (exponent - 6));
        } else {
            return numerator * (10 ** (6 - exponent));
        }
    }

    /// @notice Read-only staleness check without reverting — lets a caller
    ///         (e.g. a frontend, or RiskLegManager choosing to skip rather
    ///         than revert-and-retry) check freshness before committing to a
    ///         getPrice() call that would revert.
    function isFresh(address asset) external view returns (bool) {
        FeedConfig memory config = feeds[asset];
        if (address(config.aggregator) == address(0)) return false;

        (, int256 answer, , uint256 updatedAt, ) = config.aggregator.latestRoundData();
        if (answer <= 0) return false;

        return block.timestamp - updatedAt <= config.maxStalenessSeconds;
    }
}