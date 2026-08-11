// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed} from "../../src/interfaces/IPriceFeed.sol";

/// @notice A settable Chainlink style feed for tests and local runs. Lets a test
/// push the ETH/USD price to any value and staleness to any age so we can prove
/// the order book and executor react exactly as intended.
contract MockPriceFeed is IPriceFeed {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _updatedAt;
    uint80 private _round;

    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals = decimals_;
        _answer = initialAnswer;
        _updatedAt = block.timestamp;
        _round = 1;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function setAnswer(int256 answer) external {
        _answer = answer;
        _updatedAt = block.timestamp;
        _round++;
    }

    function setAnswerAndTime(int256 answer, uint256 updatedAt) external {
        _answer = answer;
        _updatedAt = updatedAt;
        _round++;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
