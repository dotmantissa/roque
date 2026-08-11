// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DEXRouter} from "./DEXRouter.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @title OrderBook
/// @notice Resting limit orders that anyone can trigger but nobody can cheat.
/// When you place an order the input is escrowed here. A keeper watches the
/// market and calls execute when it thinks the trigger is met, but the keeper's
/// opinion carries no weight: this contract reads the Chainlink price itself and
/// fills the order only if the condition is genuinely true. A dishonest keeper
/// can waste its own gas and nothing more.
/// @dev Prices are expressed against the configured ETH/USD feed in that feed's
/// own decimals, which on Sepolia is eight. The pair we settle is WETH/USDC.
contract OrderBook is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for int256;

    enum Status {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct Order {
        address owner; // who gets the output and can cancel
        address tokenIn; // escrowed token being sold
        address tokenOut; // token to buy
        uint256 amountIn; // escrowed amount
        uint256 minAmountOut; // slippage floor at fill time
        uint256 triggerPrice; // ETH/USD, feed decimals
        bool triggerAbove; // true: fill when price >= trigger, else <=
        uint64 expiry; // unix time after which it can only be cancelled
        Status status;
    }

    DEXRouter public immutable router;
    IPriceFeed public priceFeed;

    /// @notice Reject a Chainlink answer older than this. Generous by default so
    /// a quiet testnet feed does not strand live orders, tunable by the owner.
    uint256 public maxPriceStaleness = 24 hours;

    /// @notice The executor allowed to open orders on a user's behalf. Set once
    /// the agent stack is deployed. Orders it opens still belong to the user.
    address public agentExecutor;

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) public ordersByOwner;

    event OrderCreated(
        uint256 indexed id,
        address indexed owner,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 triggerPrice,
        bool triggerAbove,
        uint64 expiry
    );
    event OrderFilled(uint256 indexed id, address indexed filler, uint256 amountOut, int256 price);
    event OrderCancelled(uint256 indexed id);
    event AgentExecutorSet(address indexed executor);
    event PriceFeedSet(address indexed feed);

    error NotOwnerOfOrder();
    error OrderNotOpen();
    error OrderExpired();
    error TriggerNotMet(int256 price, uint256 trigger);
    error StalePrice();
    error BadPrice();
    error ZeroAmount();
    error NotAgentExecutor();

    constructor(address router_, address priceFeed_) Ownable(msg.sender) {
        router = DEXRouter(router_);
        priceFeed = IPriceFeed(priceFeed_);
    }

    // ─────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────

    function setAgentExecutor(address executor) external onlyOwner {
        agentExecutor = executor;
        emit AgentExecutorSet(executor);
    }

    function setPriceFeed(address feed) external onlyOwner {
        priceFeed = IPriceFeed(feed);
        emit PriceFeedSet(feed);
    }

    function setMaxPriceStaleness(uint256 secondsAllowed) external onlyOwner {
        maxPriceStaleness = secondsAllowed;
    }

    // ─────────────────────────────────────────────────────────────
    // Create
    // ─────────────────────────────────────────────────────────────

    /// @notice Place a limit order from your own wallet. The input is pulled and
    /// escrowed now; you get the output when the trigger fills, or your input
    /// back if you cancel.
    function createOrder(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 triggerPrice,
        bool triggerAbove,
        uint64 expiry
    ) external nonReentrant returns (uint256 id) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        id = _record(
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            minAmountOut,
            triggerPrice,
            triggerAbove,
            expiry
        );
    }

    /// @notice Open an order on behalf of a user. Only the agent executor may
    /// call this, and it must have already moved the escrow into this contract's
    /// custody by approving it for the pull below. The order still belongs to
    /// the user, who alone receives the output.
    function createOrderFor(
        address user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 triggerPrice,
        bool triggerAbove,
        uint64 expiry
    ) external nonReentrant returns (uint256 id) {
        if (msg.sender != agentExecutor) revert NotAgentExecutor();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        id = _record(
            user, tokenIn, tokenOut, amountIn, minAmountOut, triggerPrice, triggerAbove, expiry
        );
    }

    function _record(
        address owner_,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 triggerPrice,
        bool triggerAbove,
        uint64 expiry
    ) internal returns (uint256 id) {
        if (amountIn == 0) revert ZeroAmount();
        id = nextOrderId++;
        orders[id] = Order({
            owner: owner_,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            triggerPrice: triggerPrice,
            triggerAbove: triggerAbove,
            expiry: expiry,
            status: Status.Open
        });
        ordersByOwner[owner_].push(id);
        emit OrderCreated(
            id,
            owner_,
            tokenIn,
            tokenOut,
            amountIn,
            minAmountOut,
            triggerPrice,
            triggerAbove,
            expiry
        );
    }

    // ─────────────────────────────────────────────────────────────
    // Execute and cancel
    // ─────────────────────────────────────────────────────────────

    /// @notice Read the current ETH/USD price from Chainlink, reverting if the
    /// feed is stale or nonsensical.
    function currentPrice() public view returns (int256 price, uint256 updatedAt) {
        (, price,, updatedAt,) = priceFeed.latestRoundData();
        if (price <= 0) revert BadPrice();
        if (maxPriceStaleness != 0 && block.timestamp - updatedAt > maxPriceStaleness) {
            revert StalePrice();
        }
    }

    /// @notice Whether an order would fill right now. Handy for the keeper and
    /// the UI to check before spending gas.
    function isTriggered(uint256 id) public view returns (bool) {
        Order storage o = orders[id];
        if (o.status != Status.Open) return false;
        if (o.expiry != 0 && block.timestamp > o.expiry) return false;
        (int256 price,) = currentPrice();
        return
            o.triggerAbove
                ? price.toUint256() >= o.triggerPrice
                : price.toUint256() <= o.triggerPrice;
    }

    /// @notice Fill an order if and only if its trigger is genuinely met. Anyone
    /// may call this; the caller is just paying gas to move the market forward.
    function executeOrder(uint256 id) external nonReentrant returns (uint256 amountOut) {
        Order storage o = orders[id];
        if (o.status != Status.Open) revert OrderNotOpen();
        if (o.expiry != 0 && block.timestamp > o.expiry) revert OrderExpired();

        (int256 price,) = currentPrice();
        bool met = o.triggerAbove
            ? price.toUint256() >= o.triggerPrice
            : price.toUint256() <= o.triggerPrice;
        if (!met) revert TriggerNotMet(price, o.triggerPrice);

        o.status = Status.Filled;

        IERC20(o.tokenIn).forceApprove(address(router), o.amountIn);
        amountOut = router.swapExactTokensForTokens(
            o.tokenIn, o.tokenOut, o.amountIn, o.minAmountOut, o.owner, block.timestamp
        );

        emit OrderFilled(id, msg.sender, amountOut, price);
    }

    /// @notice Cancel an open order and reclaim the escrow. The owner can always
    /// cancel; the agent executor can cancel orders it opened for that owner.
    function cancelOrder(uint256 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.status != Status.Open) revert OrderNotOpen();
        if (msg.sender != o.owner && msg.sender != agentExecutor) revert NotOwnerOfOrder();

        o.status = Status.Cancelled;
        IERC20(o.tokenIn).safeTransfer(o.owner, o.amountIn);
        emit OrderCancelled(id);
    }

    // ─────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────

    function getOrder(uint256 id) external view returns (Order memory) {
        return orders[id];
    }

    function getOrdersByOwner(address owner_) external view returns (uint256[] memory) {
        return ordersByOwner[owner_];
    }
}
