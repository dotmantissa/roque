// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LiquidityPool} from "./LiquidityPool.sol";

/// @title DEXRouter
/// @notice The front door for trading. Everyone who swaps, whether a person at
/// the UI, a resting limit order, or the agent executor, comes through here. It
/// keeps a registry of which pool serves which pair, enforces deadlines so a
/// transaction cannot sit in the mempool and land at a stale price, and hands
/// back quotes for the interface to preview.
/// @dev Deliberately thin. The router never holds funds between calls and never
/// prices anything itself; it forwards to the pool and lets the curve decide.
contract DEXRouter is Ownable {
    using SafeERC20 for IERC20;

    /// @notice pair hash => pool. The hash is order independent so the same pool
    /// answers for (A,B) and (B,A).
    mapping(bytes32 => address) public pools;

    event PoolRegistered(address indexed tokenA, address indexed tokenB, address pool);
    event RouterSwap(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address to
    );

    error DeadlinePassed();
    error NoPoolForPair();
    error ZeroAddress();

    constructor() Ownable(msg.sender) {}

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        _;
    }

    function _pairKey(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @notice Point a token pair at the pool that trades it.
    function registerPool(address tokenA, address tokenB, address pool) external onlyOwner {
        if (pool == address(0) || tokenA == address(0) || tokenB == address(0)) {
            revert ZeroAddress();
        }
        pools[_pairKey(tokenA, tokenB)] = pool;
        emit PoolRegistered(tokenA, tokenB, pool);
    }

    /// @notice The pool serving a pair, or the zero address if none is set.
    function poolFor(address tokenA, address tokenB) public view returns (address) {
        return pools[_pairKey(tokenA, tokenB)];
    }

    /// @notice Preview the output for a swap. Reverts only if no pool exists.
    function quoteSwap(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        address pool = poolFor(tokenIn, tokenOut);
        if (pool == address(0)) revert NoPoolForPair();
        return LiquidityPool(pool).getAmountOut(tokenIn, amountIn);
    }

    /// @notice Swap an exact input for output, protected by a slippage floor and
    /// a deadline. Pulls tokenIn from the caller, so approve the router first.
    /// @param tokenIn Token being sold.
    /// @param tokenOut Token being bought.
    /// @param amountIn Exact input amount.
    /// @param minAmountOut Revert if output would be below this.
    /// @param to Recipient of the output.
    /// @param deadline Unix time after which the swap is void.
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountOut) {
        if (to == address(0)) revert ZeroAddress();
        address pool = poolFor(tokenIn, tokenOut);
        if (pool == address(0)) revert NoPoolForPair();

        // Bring the input in, then let the pool pull it and pay the recipient.
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(pool, amountIn);

        amountOut = LiquidityPool(pool).swap(tokenIn, amountIn, minAmountOut, to);

        emit RouterSwap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, to);
    }
}
