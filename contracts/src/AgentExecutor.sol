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
///
/// The vault has two halves: free and committed. A commitment is money this
/// contract has set aside for one named future trade, usually an event order
/// waiting on a condition or a rung of a playbook waiting its turn. That money
/// stops being spendable by anything other than the commitment it belongs to.
/// It was a database row once, which closed the app's own withdraw button and
/// left every other door open: a person could spend the same balance in
/// autonomous mode, or call withdraw on a block explorer, and the order resting
/// on it would simply fail weeks later on money nobody said was gone. A
/// mapping here cannot be routed around, so it is the mapping that decides.
contract AgentExecutor is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for int256;

    uint256 public constant BPS = 10_000;
    uint256 private constant USD = 1e18; // dollar fixed point used for caps

    /// @notice The furthest out a commitment may hold money. An order can rest
    /// for ninety days, so this is that plus room, and it is the ceiling on how
    /// long a lost or hostile agent signer could keep a vault tied up without
    /// the owner needing anybody's cooperation to get it back.
    uint64 public constant MAX_LOCK_WINDOW = 120 days;

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

    /// @notice Vault money set aside for one named future trade.
    /// @dev `epoch` counts how many times this id has been locked. A release
    /// signature names the epoch it was written for, so a signature issued
    /// against one lock cannot be replayed to undo a later one.
    struct Commitment {
        address user;
        address token;
        uint256 amount; // units still held under this commitment
        uint64 unlockAt; // after this, anyone may release it
        uint32 epoch;
        bool active;
    }

    /// @dev Signed by the agent signer, one per swap. `commitmentId` is zero for
    /// an ordinary trade, which may only spend free money, or names the
    /// commitment this trade is the fulfilment of.
    struct SwapIntent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        bytes32 commitmentId;
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
        bytes32 commitmentId;
        uint256 nonce;
        uint256 deadline;
    }

    /// @dev Signed by the agent signer to set money aside. Carries no price and
    /// moves no tokens; all it does is narrow what the rest of the vault may do.
    struct CommitIntent {
        address user;
        address token;
        uint256 amount;
        uint64 unlockAt;
        bytes32 commitmentId;
        uint256 nonce;
        uint256 deadline;
    }

    /// @dev Signed by the agent signer to give a commitment back. No nonce: the
    /// epoch already pins it to one lock, and releasing twice is harmless.
    struct ReleaseIntent {
        address user;
        bytes32 commitmentId;
        uint32 epoch;
        uint256 deadline;
    }

    bytes32 private constant SWAP_INTENT_TYPEHASH = keccak256(
        "SwapIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,bytes32 commitmentId,uint256 nonce,uint256 deadline,uint256 capabilityGeneration)"
    );
    bytes32 private constant LIMIT_INTENT_TYPEHASH = keccak256(
        "LimitIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 triggerPrice,bool triggerAbove,uint64 expiry,bytes32 commitmentId,uint256 nonce,uint256 deadline,uint256 capabilityGeneration)"
    );
    bytes32 private constant COMMIT_INTENT_TYPEHASH = keccak256(
        "CommitIntent(address user,address token,uint256 amount,uint64 unlockAt,bytes32 commitmentId,uint256 nonce,uint256 deadline,uint256 capabilityGeneration)"
    );
    bytes32 private constant RELEASE_INTENT_TYPEHASH = keccak256(
        "ReleaseIntent(address user,bytes32 commitmentId,uint32 epoch,uint256 deadline,uint256 capabilityGeneration)"
    );
    bytes32 private constant GRANT_TYPEHASH = keccak256(
        "Grant(address user,address agentSigner,uint256 maxPerTradeUsd,uint256 maxDailyUsd,uint256 maxSlippageBps,uint64 validUntil,uint256 grantNonce)"
    );

    mapping(address => uint256) public capabilityGeneration;
    mapping(address => uint256) public maxFeedAge;
    mapping(address => TokenInfo) public tokenInfo;
    mapping(address => mapping(address => uint256)) public vaultBalance; // user => token => amount
    /// @notice The part of a vault balance already set aside for commitments.
    /// Never exceeds the balance it sits inside; see `_spendVault`.
    mapping(address => mapping(address => uint256)) public lockedBalance;
    mapping(bytes32 => Commitment) public commitments;
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
    event Committed(
        bytes32 indexed commitmentId,
        address indexed user,
        address indexed token,
        uint256 amount,
        uint64 unlockAt,
        uint32 epoch
    );
    event CommitmentReleased(
        bytes32 indexed commitmentId,
        address indexed user,
        address indexed token,
        uint256 amount,
        address releasedBy
    );
    event CommitmentSpent(
        bytes32 indexed commitmentId, address indexed user, address indexed token, uint256 amount
    );
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
    error CommittedVault(uint256 free, uint256 want, uint256 locked);
    error CommitmentNotActive(bytes32 commitmentId);
    error CommitmentMismatch(bytes32 commitmentId);
    error CommitmentWindow(uint64 unlockAt);
    error CommitmentStillHeld(uint64 unlockAt);
    error CapabilityStillLive();
    error NotCommitmentOwner();
    error LengthMismatch();
    error ZeroAmount();
    error BadFeed();
    error InvalidCapability();
    error UnsupportedTransfer();

    constructor(address router_, address orderBook_)
        Ownable(msg.sender)
        EIP712("RoqueAgentExecutor", "2")
    {
        router = DEXRouter(router_);
        orderBook = OrderBook(orderBook_);
    }

    // ─────────────────────────────────────────────────────────────
    // Token registry (owner), needed to value trades in dollars
    // ─────────────────────────────────────────────────────────────

    function registerToken(address token, uint8 decimals_, bool isStable, address feed)
        external
        onlyOwner
    {
        if (token.code.length == 0 || decimals_ > 18) revert BadFeed();
        if (!isStable && (feed.code.length == 0 || IPriceFeed(feed).decimals() > 18)) {
            revert BadFeed();
        }
        maxFeedAge[token] = 1 hours;
        tokenInfo[token] = TokenInfo({
            registered: true, decimals: decimals_, isStable: isStable, feed: IPriceFeed(feed)
        });
        emit TokenRegistered(token, decimals_, isStable, feed);
    }

    function setMaxFeedAge(address token, uint256 age) external onlyOwner {
        if (!tokenInfo[token].registered || age == 0 || age > 1 days) revert BadFeed();
        maxFeedAge[token] = age;
    }

    /// @notice Value an amount of a registered token in dollars, 1e18 fixed
    /// point. Stables are one to one; everything else is priced from its feed.
    function usdValue(address token, uint256 amount) public view returns (uint256) {
        TokenInfo memory info = tokenInfo[token];
        if (!info.registered) revert TokenNotRegistered(token);
        if (info.isStable) {
            return (amount * USD) / (10 ** info.decimals);
        }
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            info.feed.latestRoundData();
        if (
            answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp
                || block.timestamp - updatedAt > maxFeedAge[token] || answeredInRound < roundId
        ) revert BadFeed();
        uint8 feedDecimals = info.feed.decimals();
        if (feedDecimals > 18) revert BadFeed();
        return (amount * answer.toUint256() * USD) / ((10 ** info.decimals) * (10 ** feedDecimals));
    }

    // ─────────────────────────────────────────────────────────────
    // Vault
    // ─────────────────────────────────────────────────────────────

    /// @notice What of a vault balance is actually spendable: the balance less
    /// anything commitments are holding. This is the figure every spend and
    /// every withdrawal is measured against.
    function availableBalance(address user, address token) public view returns (uint256) {
        uint256 bal = vaultBalance[user][token];
        uint256 locked = lockedBalance[user][token];
        return bal > locked ? bal - locked : 0;
    }

    /// @notice Move tokens into your agent vault. Only funds sitting here are
    /// ever reachable by an agent, and never beyond the caps you set.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - beforeBalance != amount) {
            revert UnsupportedTransfer();
        }
        vaultBalance[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Pull tokens back out of your vault. The agent has no say in this;
    /// it is your money. What it cannot do is take back money a resting order is
    /// already standing on, because the order would then fail at fill time on a
    /// balance nobody mentioned. Cancel the order and the hold goes with it.
    function withdraw(address token, uint256 amount) external nonReentrant {
        uint256 bal = vaultBalance[msg.sender][token];
        uint256 locked = lockedBalance[msg.sender][token];
        uint256 free = bal > locked ? bal - locked : 0;
        if (free < amount) revert CommittedVault(free, amount, locked);
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
        if (
            agentSigner == address(0) || maxPerTradeUsd == 0 || maxDailyUsd < maxPerTradeUsd
                || maxSlippageBps > 5000 || validUntil <= block.timestamp
        ) revert InvalidCapability();
        grantNonce[user]++;
        capabilityGeneration[user]++;
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
    /// agent had queued becomes worthless the moment this lands. It is also the
    /// key to your own commitments: a revoked capability cannot spend, so a hold
    /// behind it is protecting nothing, and `releaseOwnCommitment` opens up.
    function revokeCapability() external {
        Capability storage c = capabilities[msg.sender];
        if (!c.exists) revert CapabilityMissing();
        c.revoked = true;
        grantNonce[msg.sender]++;
        capabilityGeneration[msg.sender]++;
        emit CapabilityRevoked(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────
    // Commitments: vault money spoken for
    // ─────────────────────────────────────────────────────────────

    /// @notice Set money aside for one named future trade.
    /// @dev Agent-signed, inside a live capability, exactly like a swap. A lock
    /// is strictly weaker than a spend: it moves no tokens, it can only ever
    /// hold money the vault already has free, it expires on its own, and the
    /// owner can take it back by revoking. So it is not valued in dollars and
    /// not booked against the daily cap, which also keeps a feed outage from
    /// being able to stop somebody arming an order.
    ///
    /// Locking an id that is already live resizes it rather than stacking a
    /// second claim on top, which is what makes arming the same order twice
    /// harmless. The nonce still has to be fresh, so nobody can replay an old
    /// lock to resize a commitment behind the app's back.
    function lockForCommitment(CommitIntent calldata intent, bytes calldata signature)
        external
        nonReentrant
    {
        _lock(intent, signature);
    }

    /// @notice Lock several commitments in one transaction, which is what arming
    /// a multi-rung playbook needs. All or nothing: one bad leg reverts the set,
    /// so a plan is never half funded.
    function lockForCommitments(CommitIntent[] calldata intents, bytes[] calldata signatures)
        external
        nonReentrant
    {
        if (intents.length != signatures.length) revert LengthMismatch();
        for (uint256 i = 0; i < intents.length; i++) {
            _lock(intents[i], signatures[i]);
        }
    }

    function _lock(CommitIntent calldata intent, bytes calldata signature) internal {
        if (intent.amount == 0) revert ZeroAmount();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (!tokenInfo[intent.token].registered) revert TokenNotRegistered(intent.token);
        if (
            intent.unlockAt <= block.timestamp
                || intent.unlockAt > block.timestamp + MAX_LOCK_WINDOW
        ) {
            revert CommitmentWindow(intent.unlockAt);
        }

        _requireAgent(intent.user, _hashCommit(intent), signature);
        if (usedNonce[intent.user][intent.nonce]) revert NonceUsed(intent.nonce);
        usedNonce[intent.user][intent.nonce] = true;

        Commitment storage c = commitments[intent.commitmentId];
        if (c.active) {
            // A resize of a live claim. Anything it already holds is its own, so
            // the new figure is judged against the balance with the old claim
            // taken back out rather than against what is free beside it.
            if (c.user != intent.user || c.token != intent.token) {
                revert CommitmentMismatch(intent.commitmentId);
            }
            lockedBalance[intent.user][intent.token] -= c.amount;
            c.amount = 0;
        }

        uint256 free = availableBalance(intent.user, intent.token);
        if (free < intent.amount) {
            revert CommittedVault(free, intent.amount, lockedBalance[intent.user][intent.token]);
        }

        lockedBalance[intent.user][intent.token] += intent.amount;
        c.user = intent.user;
        c.token = intent.token;
        c.amount = intent.amount;
        c.unlockAt = intent.unlockAt;
        c.epoch += 1;
        c.active = true;

        emit Committed(
            intent.commitmentId, intent.user, intent.token, intent.amount, intent.unlockAt, c.epoch
        );
    }

    /// @notice Give a commitment back, on the agent's signature. This is the
    /// ordinary path: the order was cancelled, refused, expired or filled, so
    /// the hold behind it ends. Releasing something already released is a
    /// no-op rather than a revert, so a cleanup sweep can be run twice.
    function releaseCommitment(ReleaseIntent calldata intent, bytes calldata signature)
        external
        nonReentrant
    {
        _releaseSigned(intent, signature);
    }

    /// @notice Release several at once, which is what finishing or cancelling a
    /// playbook needs.
    function releaseCommitments(ReleaseIntent[] calldata intents, bytes[] calldata signatures)
        external
        nonReentrant
    {
        if (intents.length != signatures.length) revert LengthMismatch();
        for (uint256 i = 0; i < intents.length; i++) {
            _releaseSigned(intents[i], signatures[i]);
        }
    }

    function _releaseSigned(ReleaseIntent calldata intent, bytes calldata signature) internal {
        if (block.timestamp > intent.deadline) revert IntentExpired();
        Commitment storage c = commitments[intent.commitmentId];
        if (!c.active) return; // already gone; nothing to undo
        if (c.user != intent.user) revert CommitmentMismatch(intent.commitmentId);
        if (c.epoch != intent.epoch) revert CommitmentMismatch(intent.commitmentId);
        _requireAgent(intent.user, _hashRelease(intent), signature);
        _release(intent.commitmentId, c);
    }

    /// @notice Release a commitment whose window has run out. Deliberately open
    /// to anyone: the hold has a stated end, and past it nobody should need the
    /// relayer's cooperation to make that end real.
    function releaseExpiredCommitment(bytes32 commitmentId) external nonReentrant {
        Commitment storage c = commitments[commitmentId];
        if (!c.active) revert CommitmentNotActive(commitmentId);
        if (block.timestamp < c.unlockAt) revert CommitmentStillHeld(c.unlockAt);
        _release(commitmentId, c);
    }

    /// @notice Take back your own commitment once your capability can no longer
    /// spend it. Revoking is the one move that needs nobody's permission, so
    /// this is the exit that makes the hold safe to grant in the first place:
    /// money in here can be set aside without ever being trapped. It is a
    /// deliberate, visible act, and it switches the agent off on the way out.
    function releaseOwnCommitment(bytes32 commitmentId) external nonReentrant {
        Commitment storage c = commitments[commitmentId];
        if (!c.active) revert CommitmentNotActive(commitmentId);
        if (c.user != msg.sender) revert NotCommitmentOwner();
        Capability memory cap = capabilities[msg.sender];
        bool spendable = cap.exists && !cap.revoked && block.timestamp <= cap.validUntil;
        if (spendable) revert CapabilityStillLive();
        _release(commitmentId, c);
    }

    function _release(bytes32 commitmentId, Commitment storage c) internal {
        uint256 amount = c.amount;
        address user = c.user;
        address token = c.token;
        uint256 locked = lockedBalance[user][token];
        lockedBalance[user][token] = locked > amount ? locked - amount : 0;
        c.amount = 0;
        c.active = false;
        emit CommitmentReleased(commitmentId, user, token, amount, msg.sender);
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
        _spendVault(intent.user, intent.tokenIn, intent.amountIn, intent.commitmentId);
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

        _checkSlippage(
            intent.tokenIn, intent.tokenOut, intent.amountIn, intent.minAmountOut, intent.user
        );

        _spendVault(intent.user, intent.tokenIn, intent.amountIn, intent.commitmentId);
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

        Capability memory c = _requireAgent(user, structHash, signature);

        if (usedNonce[user][nonce]) revert NonceUsed(nonce);
        usedNonce[user][nonce] = true;

        valueUsd = usdValue(tokenIn, amountIn);
        if (valueUsd > c.maxPerTradeUsd) revert OverPerTradeCap(valueUsd, c.maxPerTradeUsd);

        uint256 day = block.timestamp / 1 days;
        uint256 wouldBe = dailyUsdSpent[user][day] + valueUsd;
        if (wouldBe > c.maxDailyUsd) revert OverDailyCap(wouldBe, c.maxDailyUsd);
        dailyUsdSpent[user][day] = wouldBe;
    }

    /// @dev The capability must exist, be live, and the recovered signer must be
    /// the key it names. Shared by every agent action, including the two that
    /// only move money between the free and committed halves of a vault.
    function _requireAgent(address user, bytes32 structHash, bytes calldata signature)
        internal
        view
        returns (Capability memory c)
    {
        c = capabilities[user];
        if (!c.exists) revert CapabilityMissing();
        if (c.revoked) revert CapabilityRevokedError();
        if (block.timestamp > c.validUntil) revert CapabilityExpired();

        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != c.agentSigner) revert WrongSigner(signer, c.agentSigner);
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
        if (minAmountOut == 0 || minAmountOut < floor) revert SlippageTooHigh(minAmountOut, floor);
    }

    /// @dev Take `amount` out of the vault for a trade.
    ///
    /// With no commitment named this may only reach the free half, which is the
    /// whole point of the mapping: an autonomous trade cannot quietly spend what
    /// an event order is standing on, convert it to another token and walk it
    /// out through a withdrawal the lock never saw.
    ///
    /// With one named, the commitment is consumed first and the spend is then
    /// judged against the balance that frees up. Consumed whole, not partially:
    /// a commitment stands for one trade, that trade is happening now, and a
    /// remainder left holding money for a fill that already came is just a
    /// locked dust balance nobody will think to release. A fill larger than its
    /// hold is fine too, so long as the difference is genuinely free.
    function _spendVault(address user, address token, uint256 amount, bytes32 commitmentId)
        internal
    {
        if (commitmentId != bytes32(0)) {
            Commitment storage c = commitments[commitmentId];
            if (!c.active) revert CommitmentNotActive(commitmentId);
            if (c.user != user || c.token != token) revert CommitmentMismatch(commitmentId);
            uint256 held = c.amount;
            _release(commitmentId, c);
            emit CommitmentSpent(commitmentId, user, token, held);
        }

        uint256 bal = vaultBalance[user][token];
        uint256 locked = lockedBalance[user][token];
        uint256 free = bal > locked ? bal - locked : 0;
        if (free < amount) {
            if (locked == 0) revert InsufficientVault(free, amount);
            revert CommittedVault(free, amount, locked);
        }
        vaultBalance[user][token] = bal - amount;
    }

    function _hashSwap(SwapIntent calldata i) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                SWAP_INTENT_TYPEHASH,
                i.user,
                i.tokenIn,
                i.tokenOut,
                i.amountIn,
                i.minAmountOut,
                i.commitmentId,
                i.nonce,
                i.deadline,
                capabilityGeneration[i.user]
            )
        );
    }

    function _hashLimit(LimitIntent calldata i) internal view returns (bytes32) {
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
                i.commitmentId,
                i.nonce,
                i.deadline,
                capabilityGeneration[i.user]
            )
        );
    }

    function _hashCommit(CommitIntent calldata i) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                COMMIT_INTENT_TYPEHASH,
                i.user,
                i.token,
                i.amount,
                i.unlockAt,
                i.commitmentId,
                i.nonce,
                i.deadline,
                capabilityGeneration[i.user]
            )
        );
    }

    function _hashRelease(ReleaseIntent calldata i) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                RELEASE_INTENT_TYPEHASH,
                i.user,
                i.commitmentId,
                i.epoch,
                i.deadline,
                capabilityGeneration[i.user]
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

    function getCommitment(bytes32 commitmentId) external view returns (Commitment memory) {
        return commitments[commitmentId];
    }

    function remainingDailyUsd(address user) external view returns (uint256) {
        Capability memory c = capabilities[user];
        if (!c.exists) return 0;
        uint256 spent = dailyUsdSpent[user][block.timestamp / 1 days];
        return spent >= c.maxDailyUsd ? 0 : c.maxDailyUsd - spent;
    }
}
