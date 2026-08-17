// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IChainlinkAggregator} from "../interfaces/IChainlinkAggregator.sol";

/// @notice Test double for a Chainlink price feed. Lets tests directly set
///         the answer and updatedAt timestamp to exercise OracleConsumer's
///         staleness logic (§10.9) deterministically, without depending on
///         real Chainlink infrastructure or block-timing races.
contract MockChainlinkAggregator is IChainlinkAggregator {
    int256 private _answer;
    uint256 private _updatedAt;
    uint8 private _decimals;
    uint80 private _roundId;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    /// @notice Test hook: set the latest answer and its update timestamp.
    function setLatestAnswer(int256 answer, uint256 updatedAt) external {
        _answer = answer;
        _updatedAt = updatedAt;
        _roundId += 1;
    }

    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }
}