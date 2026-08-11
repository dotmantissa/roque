// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title LiquidityPool
/// @notice A constant product market maker for a single token pair. This is the
/// deterministic heart of Roque: no oracle, no admin lever over pricing, no AI.
/// Price is whatever the reserves say it is, and the only way to move it is to
/// trade against it. Liquidity providers get shares that track their slice of
/// the pool, and a small fee on every swap accrues to those shares.
/// @dev The math is the well understood Uniswap V2 style x*y=k. We keep our own
/// share accounting rather than minting a separate ERC20 to keep the surface
/// small and easy to audit for the hackathon.
contract LiquidityPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The two tokens in the pair. token0/token1 ordering is fixed at
    /// construction and every reserve and amount is expressed in that order.
    IERC20 public immutable token0;
    IERC20 public immutable token1;

    /// @notice Swap fee in basis points, e.g. 30 means 0.30 percent.
    uint256 public immutable feeBps;
    uint256 public constant BPS = 10_000;

    /// @notice A tiny amount of the very first liquidity is locked forever so the
    /// pool can never be fully drained back to a zero supply, which would let
    /// someone grief the share price. Standard practice, cheap insurance.
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;

    uint256 public reserve0;
    uint256 public reserve1;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event LiquidityAdded(
        address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesMinted
    );
    event LiquidityRemoved(
        address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesBurned
    );
    event Swapped(
        address indexed trader,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        address indexed to
    );
    event Synced(uint256 reserve0, uint256 reserve1);

    error IdenticalTokens();
    error ZeroAddress();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientInput();
    error InsufficientOutput();
    error InsufficientLiquidity();
    error WrongToken();

    constructor(address tokenA, address tokenB, uint256 feeBps_) {
        if (tokenA == tokenB) revert IdenticalTokens();
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        // Sort so the pair is canonical regardless of constructor argument order.
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        token0 = IERC20(t0);
        token1 = IERC20(t1);
        feeBps = feeBps_;
    }

    /// @notice Current reserves, in token0 then token1 order.
    function getReserves() external view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    // ─────────────────────────────────────────────────────────────
    // Liquidity
    // ─────────────────────────────────────────────────────────────

    /// @notice Deposit both tokens and receive pool shares. The caller must have
    /// approved this contract for at least the amounts passed. On the first ever
    /// deposit the ratio you send sets the starting price, so send them at the
    /// value you believe in.
    /// @param amount0Desired How much token0 you want to add.
    /// @param amount1Desired How much token1 you want to add.
    /// @param to Who receives the shares.
    function addLiquidity(uint256 amount0Desired, uint256 amount1Desired, address to)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1, uint256 shares)
    {
        if (to == address(0)) revert ZeroAddress();

        if (totalShares == 0) {
            // First provider sets the price. Take exactly what they offered.
            amount0 = amount0Desired;
            amount1 = amount1Desired;
        } else {
            // Keep the pool balanced: match the desired amounts to the current
            // ratio, favouring whichever side is the binding constraint.
            uint256 amount1Optimal = (amount0Desired * reserve1) / reserve0;
            if (amount1Optimal <= amount1Desired) {
                amount0 = amount0Desired;
                amount1 = amount1Optimal;
            } else {
                uint256 amount0Optimal = (amount1Desired * reserve0) / reserve1;
                amount0 = amount0Optimal;
                amount1 = amount1Desired;
            }
        }

        if (amount0 == 0 || amount1 == 0) revert InsufficientInput();

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        if (totalShares == 0) {
            shares = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            // Lock the minimum by assigning it to a burn sink via totalShares.
            totalShares = MINIMUM_LIQUIDITY;
        } else {
            shares =
                Math.min((amount0 * totalShares) / reserve0, (amount1 * totalShares) / reserve1);
        }

        if (shares == 0) revert InsufficientLiquidityMinted();

        totalShares += shares;
        sharesOf[to] += shares;

        reserve0 += amount0;
        reserve1 += amount1;

        emit LiquidityAdded(to, amount0, amount1, shares);
        emit Synced(reserve0, reserve1);
    }

    /// @notice Burn shares and pull your proportional slice of both reserves.
    /// @param shares How many shares to redeem.
    /// @param to Who receives the underlying tokens.
    function removeLiquidity(uint256 shares, address to)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (to == address(0)) revert ZeroAddress();
        if (shares == 0 || sharesOf[msg.sender] < shares) revert InsufficientLiquidityBurned();

        amount0 = (shares * reserve0) / totalShares;
        amount1 = (shares * reserve1) / totalShares;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;

        reserve0 -= amount0;
        reserve1 -= amount1;

        token0.safeTransfer(to, amount0);
        token1.safeTransfer(to, amount1);

        emit LiquidityRemoved(msg.sender, amount0, amount1, shares);
        emit Synced(reserve0, reserve1);
    }

    // ─────────────────────────────────────────────────────────────
    // Swap
    // ─────────────────────────────────────────────────────────────

    /// @notice Quote how much token you would receive for a given input, fee
    /// included. Pure reserve math, safe to call off-chain for previews.
    function getAmountOut(address tokenIn, uint256 amountIn)
        public
        view
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInput();
        (uint256 reserveIn, uint256 reserveOut) = _reservesFor(tokenIn);
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * (BPS - feeBps);
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * BPS) + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @notice Swap an exact input amount for as much output as the curve gives,
    /// reverting if that falls short of minAmountOut. Tokens must already be
    /// approved to this contract.
    /// @param tokenIn Which side you are selling.
    /// @param amountIn Exact input amount.
    /// @param minAmountOut Slippage floor. Revert if the output is below this.
    /// @param to Recipient of the output token.
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (to == address(0)) revert ZeroAddress();
        if (tokenIn != address(token0) && tokenIn != address(token1)) revert WrongToken();

        amountOut = getAmountOut(tokenIn, amountIn);
        if (amountOut < minAmountOut) revert InsufficientOutput();

        (IERC20 tin, IERC20 tout) = tokenIn == address(token0) ? (token0, token1) : (token1, token0);

        tin.safeTransferFrom(msg.sender, address(this), amountIn);
        tout.safeTransfer(to, amountOut);

        _sync();
        emit Swapped(msg.sender, tokenIn, amountIn, amountOut, to);
    }

    // ─────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────

    function _reservesFor(address tokenIn)
        internal
        view
        returns (uint256 reserveIn, uint256 reserveOut)
    {
        if (tokenIn == address(token0)) return (reserve0, reserve1);
        if (tokenIn == address(token1)) return (reserve1, reserve0);
        revert WrongToken();
    }

    /// @dev Pull reserves back in line with real balances after a swap. Because
    /// transfers are exact and we hold no rebasing tokens, this simply reflects
    /// the input in and output out.
    function _sync() internal {
        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));
        emit Synced(reserve0, reserve1);
    }
}
