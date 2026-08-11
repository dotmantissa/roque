// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/TestToken.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {DEXRouter} from "../src/DEXRouter.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {MockPriceFeed} from "./mocks/MockPriceFeed.sol";

/// @notice Shared setup for the whole Roque stack. Deploys tokens, a seeded
/// WETH/USDC pool at roughly 2500 dollars per ether, the router, the order book
/// wired to a mock feed, and the agent executor with both tokens registered for
/// dollar valuation. Also carries the EIP-712 helpers the executor tests need.
contract Base is Test {
    TestToken internal usdc;
    TestToken internal weth;
    LiquidityPool internal pool;
    DEXRouter internal router;
    OrderBook internal orderBook;
    AgentExecutor internal executor;
    MockPriceFeed internal feed;

    // Feed reports ETH/USD with 8 decimals, the Sepolia convention.
    int256 internal constant ETH_USD = 2500e8;

    address internal deployer = address(this);
    address internal alice = makeAddr("alice");
    address internal liquidityProvider = makeAddr("lp");

    // A known agent signer keypair for signing intents in tests.
    uint256 internal agentPk = 0xA6E77;
    address internal agentSigner = vm.addr(0xA6E77);

    bytes32 internal constant SWAP_INTENT_TYPEHASH = keccak256(
        "SwapIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant LIMIT_INTENT_TYPEHASH = keccak256(
        "LimitIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint256 triggerPrice,bool triggerAbove,uint64 expiry,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant GRANT_TYPEHASH = keccak256(
        "Grant(address user,address agentSigner,uint256 maxPerTradeUsd,uint256 maxDailyUsd,uint256 maxSlippageBps,uint64 validUntil,uint256 grantNonce)"
    );

    function setUp() public virtual {
        usdc = new TestToken("Roque USD", "USDC", 6, 1_000e6);
        weth = new TestToken("Roque Wrapped Ether", "WETH", 18, 1e18);
        feed = new MockPriceFeed(8, ETH_USD);

        router = new DEXRouter();
        pool = new LiquidityPool(address(usdc), address(weth), 30); // 0.30% fee
        router.registerPool(address(usdc), address(weth), address(pool));

        orderBook = new OrderBook(address(router), address(feed));
        executor = new AgentExecutor(address(router), address(orderBook));
        orderBook.setAgentExecutor(address(executor));

        executor.registerToken(address(usdc), 6, true, address(0));
        executor.registerToken(address(weth), 18, false, address(feed));

        _seedPool();
    }

    /// @dev Seed the pool at 2500 USDC per WETH: 2,500,000 USDC against 1000 WETH.
    function _seedPool() internal {
        usdc.mint(liquidityProvider, 2_500_000e6);
        weth.mint(liquidityProvider, 1_000e18);
        (uint256 amount0, uint256 amount1) = _sortedAmounts(2_500_000e6, 1_000e18);
        vm.startPrank(liquidityProvider);
        usdc.approve(address(pool), type(uint256).max);
        weth.approve(address(pool), type(uint256).max);
        pool.addLiquidity(amount0, amount1, liquidityProvider);
        vm.stopPrank();
    }

    /// @dev Map a (usdc, weth) amount pair into the pool's token0/token1 order,
    /// which is fixed by address sorting inside the pool.
    function _sortedAmounts(uint256 usdcAmount, uint256 wethAmount)
        internal
        view
        returns (uint256 amount0, uint256 amount1)
    {
        return address(usdc) < address(weth) ? (usdcAmount, wethAmount) : (wethAmount, usdcAmount);
    }

    // ── EIP-712 helpers ─────────────────────────────────────────

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", executor.domainSeparator(), structHash));
    }

    function _signSwap(uint256 pk, AgentExecutor.SwapIntent memory i)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _signLimit(uint256 pk, AgentExecutor.LimitIntent memory i)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(structHash));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Give a user a funded vault ready for agent trades.
    function _fundVault(address user, uint256 usdcAmount) internal {
        usdc.mint(user, usdcAmount);
        vm.startPrank(user);
        usdc.approve(address(executor), usdcAmount);
        executor.deposit(address(usdc), usdcAmount);
        vm.stopPrank();
    }

    /// @dev Standard capability: $500 per trade, $2000 per day, 1% slippage.
    function _grantStandard(address user) internal {
        vm.prank(user);
        executor.grantCapability(
            agentSigner, 500e18, 2_000e18, 100, uint64(block.timestamp + 7 days)
        );
    }
}
