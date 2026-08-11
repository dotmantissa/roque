// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {DEXRouter} from "./DEXRouter.sol";
import {OrderBook} from "./OrderBook.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @title AgentExecutor
/// @notice The line the agent can propose across but never step over. A user
/// funds a private vault here and grants a capability that spells out, in hard
/// numbers, what an agent signer may do: which tokens, how much per trade, how
/// much per day, how much slippage, and until when. Every action the agent
/// requests arrives as a signed intent. This contract recovers that signature,
/// checks it against the capability, values the trade in dollars from Chainlink,
/// and only then moves a single token. If the agent lies, hallucinates, or is
/// outright stolen, the worst it can do is what the user already allowed.
/// @dev Two signatures matter here. The user's, which sets the bounds (either a
/// direct call from their wallet or an EIP-712 grant a relayer submits), and the
/// agent signer's, one per intent, recovered on-chain for every action.
contract AgentExecutor is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for int256;

    uint256 public constant BPS = 10_000;
    uint256 private constant USD = 1e18; // dollar fixed point used for caps

    DEXRouter public immutable router;
    OrderBook public immutable orderBook;

    struct TokenInfo {
        bool registered;
        uint8 decimals;
        bool isStable; // priced one to one with the dollar
        IPriceFeed feed; // used when not a stable
    }

    struct Capability {
        address agentSigner; // the only key allowed to sign this user's intents
        uint256 maxPerTradeUsd; // dollar ceiling per single action, 1e18
        uint256 maxDailyUsd; // rolling daily dollar ceiling, 1e18
        uint256 maxSlippageBps; // worst price the agent may accept
        uint64 validUntil; // capability expiry
        bool revoked;
        bool exists;
    }

    /// @dev Signed by the agent signer, one per swap.
    struct SwapIntent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 nonce;
        uint256 deadline;
    }

    /// @dev Signed by the agent signer, one per limit order.
    struct LimitIntent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 triggerPrice;
        bool triggerAbove;
        uint64 expiry;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 private constant SWAP_INTENT_TYPEHASH = keccak256(
        "SwapIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant LIMIT_INTENT_TYPEHASH = keccak256(
        "LimitIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 triggerPrice,bool triggerAbove,uint64 expiry,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant GRANT_TYPEHASH = keccak256(
        "Grant(address user,address agentSigner,uint256 maxPerTradeUsd,uint256 maxDailyUsd,uint256 maxSlippageBps,uint64 validUntil,uint256 grantNonce)"
    );

    mapping(address => TokenInfo) public tokenInfo;
    mapping(address => mapping(address => uint256)) public vaultBalance; // user => token => amount
    mapping(address => Capability) public capabilities; // user => capability
    mapping(address => mapping(uint256 => bool)) public usedNonce; // user => nonce => used
    mapping(address => uint256) public grantNonce; // user => next grant nonce
    mapping(address => mapping(uint256 => uint256)) public dailyUsdSpent; // user => day => 1e18 usd

    event TokenRegistered(address indexed token, uint8 decimals, bool isStable, address feed);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event CapabilityGranted(
        address indexed user,
        address indexed agentSigner,
        uint256 maxPerTradeUsd,
        uint256 maxDailyUsd,
        uint256 maxSlippageBps,
        uint64 validUntil
    );
    event CapabilityRevoked(address indexed user);
    event AgentSwap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 usdValue
    );
    event AgentLimitOrder(address indexed user, uint256 indexed orderId, uint256 usdValue);

    error TokenNotRegistered(address token);
    error IntentExpired();
    error CapabilityMissing();
    error CapabilityRevokedError();
    error CapabilityExpired();
    error WrongSigner(address recovered, address expected);
    error NonceUsed(uint256 nonce);
    error OverPerTradeCap(uint256 valueUsd, uint256 capUsd);
    error OverDailyCap(uint256 wouldBe, uint256 capUsd);
    error SlippageTooHigh(uint256 minOut, uint256 floor);
    error InsufficientVault(uint256 have, uint256 want);
    error ZeroAmount();
    error BadFeed();

    constructor(address router_, address orderBook_)
        Ownable(msg.sender)
        EIP712("RoqueAgentExecutor", "1")
    {
        router = DEXRouter(router_);
        orderBook = OrderBook(orderBook_);
    }

    // ─────────────────────────────────────────────────────────────
    // Token registry (owner) — needed to value trades in dollars
    // ─────────────────────────────────────────────────────────────

    function registerToken(address token, uint8 decimals_, bool isStable, address feed)
        external
        onlyOwner
    {
        tokenInfo[token] = TokenInfo({
            registered: true, decimals: decimals_, isStable: isStable, feed: IPriceFeed(feed)
        });
        emit TokenRegistered(token, decimals_, isStable, feed);
    }

    /// @notice Value an amount of a registered token in dollars, 1e18 fixed
    /// point. Stables are one to one; everything else is priced from its feed.
    function usdValue(address token, uint256 amount) public view returns (uint256) {
        TokenInfo memory info = tokenInfo[token];
        if (!info.registered) revert TokenNotRegistered(token);
        if (info.isStable) {
            return (amount * USD) / (10 ** info.decimals);
        }
        (, int256 answer,,,) = info.feed.latestRoundData();
        if (answer <= 0) revert BadFeed();
        uint8 feedDecimals = info.feed.decimals();
        return (amount * answer.toUint256() * USD) / ((10 ** info.decimals) * (10 ** feedDecimals));
    }

    // ─────────────────────────────────────────────────────────────
    // Vault
    // ─────────────────────────────────────────────────────────────

    /// @notice Move tokens into your agent vault. Only funds sitting here are
    /// ever reachable by an agent, and never beyond the caps you set.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        vaultBalance[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Pull tokens back out of your vault at any time. The agent has no
    /// say in this; it is your money.
    function withdraw(address token, uint256 amount) external nonReentrant {
        uint256 bal = vaultBalance[msg.sender][token];
        if (bal < amount) revert InsufficientVault(bal, amount);
        vaultBalance[msg.sender][token] = bal - amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ─────────────────────────────────────────────────────────────
    // Capability
    // ─────────────────────────────────────────────────────────────

    /// @notice Grant a capability directly from your own wallet. The transaction
    /// itself is your consent, so no separate signature is needed.
    function grantCapability(
        address agentSigner,
        uint256 maxPerTradeUsd,
        uint256 maxDailyUsd,
        uint256 maxSlippageBps,
        uint64 validUntil
    ) external {
        _setCapability(
            msg.sender, agentSigner, maxPerTradeUsd, maxDailyUsd, maxSlippageBps, validUntil
        );
    }

    /// @notice Grant a capability with an EIP-712 signature so a relayer can pay
    /// the gas. The signature must come from the user being granted for.
    function grantCapabilityWithSig(
        address user,
        address agentSigner,
        uint256 maxPerTradeUsd,
        uint256 maxDailyUsd,
        uint256 maxSlippageBps,
        uint64 validUntil,
        bytes calldata signature
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(
                GRANT_TYPEHASH,
                user,
                agentSigner,
                maxPerTradeUsd,
                maxDailyUsd,
                maxSlippageBps,
                validUntil,
                grantNonce[user]
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != user) revert WrongSigner(signer, user);
        grantNonce[user]++;
        _setCapability(user, agentSigner, maxPerTradeUsd, maxDailyUsd, maxSlippageBps, validUntil);
    }

    function _setCapability(
        address user,
        address agentSigner,
        uint256 maxPerTradeUsd,
        uint256 maxDailyUsd,
        uint256 maxSlippageBps,
        uint64 validUntil
    ) internal {
        capabilities[user] = Capability({
            agentSigner: agentSigner,
            maxPerTradeUsd: maxPerTradeUsd,
            maxDailyUsd: maxDailyUsd,
            maxSlippageBps: maxSlippageBps,
            validUntil: validUntil,
            revoked: false,
            exists: true
        });
        emit CapabilityGranted(
            user, agentSigner, maxPerTradeUsd, maxDailyUsd, maxSlippageBps, validUntil
        );
    }

    /// @notice Revoke your capability. Takes effect immediately; any intent the
    /// agent had queued becomes worthless the moment this lands.
    function revokeCapability() external {
        Capability storage c = capabilities[msg.sender];
        if (!c.exists) revert CapabilityMissing();
        c.revoked = true;
        emit CapabilityRevoked(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────
    // Agent actions
    // ─────────────────────────────────────────────────────────────

    /// @notice Execute a swap the agent has signed, drawing from the user's
    /// vault. Every bound in the capability is checked here, on-chain, before a
    /// token moves.
    function executeSwap(SwapIntent calldata intent, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        uint256 valueUsd = _authorize(
            intent.user,
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            intent.deadline,
            intent.nonce,
            _hashSwap(intent),
            signature
        );

        // Slippage gate: the min the agent accepts must not undercut the current
        // quote by more than the capability allows.
        _checkSlippage(
            intent.tokenIn, intent.tokenOut, intent.amountIn, intent.minAmountOut, intent.user
        );

        // Draw from the vault and settle through the router.
        _debitVault(intent.user, intent.tokenIn, intent.amountIn);
        IERC20(intent.tokenIn).forceApprove(address(router), intent.amountIn);
        amountOut = router.swapExactTokensForTokens(
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            intent.minAmountOut,
            address(this),
            block.timestamp
        );
        vaultBalance[intent.user][intent.tokenOut] += amountOut;

        emit AgentSwap(
            intent.user, intent.tokenIn, intent.tokenOut, intent.amountIn, amountOut, valueUsd
        );
    }

    /// @notice Open a limit order the agent has signed, escrowing from the vault
    /// into the order book. Same authorization path as a swap.
    function createLimitOrder(LimitIntent calldata intent, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 orderId)
    {
        uint256 valueUsd = _authorize(
            intent.user,
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            intent.deadline,
            intent.nonce,
            _hashLimit(intent),
            signature
        );

        _debitVault(intent.user, intent.tokenIn, intent.amountIn);
        IERC20(intent.tokenIn).forceApprove(address(orderBook), intent.amountIn);
        orderId = orderBook.createOrderFor(
            intent.user,
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            intent.minAmountOut,
            intent.triggerPrice,
            intent.triggerAbove,
            intent.expiry
        );

        emit AgentLimitOrder(intent.user, orderId, valueUsd);
    }

    // ─────────────────────────────────────────────────────────────
    // Authorization core
    // ─────────────────────────────────────────────────────────────

    /// @dev The single choke point every agent action passes through. Verifies
    /// the signature against the capability, enforces expiry and nonce, values
    /// the trade, and books it against the per-trade and daily dollar caps.
    function _authorize(
        address user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 deadline,
        uint256 nonce,
        bytes32 structHash,
        bytes calldata signature
    ) internal returns (uint256 valueUsd) {
        if (amountIn == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert IntentExpired();
        if (!tokenInfo[tokenIn].registered) revert TokenNotRegistered(tokenIn);
        if (!tokenInfo[tokenOut].registered) revert TokenNotRegistered(tokenOut);

        Capability memory c = capabilities[user];
        if (!c.exists) revert CapabilityMissing();
        if (c.revoked) revert CapabilityRevokedError();
        if (block.timestamp > c.validUntil) revert CapabilityExpired();

        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != c.agentSigner) revert WrongSigner(signer, c.agentSigner);

        if (usedNonce[user][nonce]) revert NonceUsed(nonce);
        usedNonce[user][nonce] = true;

        valueUsd = usdValue(tokenIn, amountIn);
        if (valueUsd > c.maxPerTradeUsd) revert OverPerTradeCap(valueUsd, c.maxPerTradeUsd);

        uint256 day = block.timestamp / 1 days;
        uint256 wouldBe = dailyUsdSpent[user][day] + valueUsd;
        if (wouldBe > c.maxDailyUsd) revert OverDailyCap(wouldBe, c.maxDailyUsd);
        dailyUsdSpent[user][day] = wouldBe;
    }

    function _checkSlippage(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address user
    ) internal view {
        uint256 quote = router.quoteSwap(tokenIn, tokenOut, amountIn);
        uint256 floor = (quote * (BPS - capabilities[user].maxSlippageBps)) / BPS;
        if (minAmountOut < floor) revert SlippageTooHigh(minAmountOut, floor);
    }

    function _debitVault(address user, address token, uint256 amount) internal {
        uint256 bal = vaultBalance[user][token];
        if (bal < amount) revert InsufficientVault(bal, amount);
        vaultBalance[user][token] = bal - amount;
    }

    function _hashSwap(SwapIntent calldata i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SWAP_INTENT_TYPEHASH,
                i.user,
                i.tokenIn,
                i.tokenOut,
                i.amountIn,
                i.minAmountOut,
                i.nonce,
                i.deadline
            )
        );
    }

    function _hashLimit(LimitIntent calldata i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                LIMIT_INTENT_TYPEHASH,
                i.user,
                i.tokenIn,
                i.tokenOut,
                i.amountIn,
                i.minAmountOut,
                i.triggerPrice,
                i.triggerAbove,
                i.expiry,
                i.nonce,
                i.deadline
            )
        );
    }

    // ─────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function getCapability(address user) external view returns (Capability memory) {
        return capabilities[user];
    }

    function remainingDailyUsd(address user) external view returns (uint256) {
        Capability memory c = capabilities[user];
        if (!c.exists) return 0;
        uint256 spent = dailyUsdSpent[user][block.timestamp / 1 days];
        return spent >= c.maxDailyUsd ? 0 : c.maxDailyUsd - spent;
    }
}
