// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TestToken} from "../src/TestToken.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {DEXRouter} from "../src/DEXRouter.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

/// @notice One shot deploy of the whole Roque stack to Sepolia. Deploys the two
/// test tokens, the pool, the router, the order book pointed at the real
/// Chainlink ETH/USD feed, and the agent executor, wires them together, seeds an
/// initial pool at roughly 2500 dollars per ether, then writes every address to
/// deployments/sepolia.json for the app and backend to consume.
contract Deploy is Script {
    // Chainlink ETH/USD on Sepolia, 8 decimals.
    address constant SEPOLIA_ETH_USD = 0x694AA1769357215DE4FAC081bf1f309aDC325306;

    // Initial pool seed. 2,500,000 USDC against 1000 WETH sets the price at 2500.
    uint256 constant SEED_USDC = 2_500_000e6;
    uint256 constant SEED_WETH = 1_000e18;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        // Derive the agent signer address straight from its key so the key file
        // stays the single source of truth and the two can never drift apart.
        address agentSigner = vm.addr(vm.envUint("AGENT_SIGNER_PRIVATE_KEY"));

        console.log("Deployer:", deployer);
        console.log("Agent signer:", agentSigner);

        vm.startBroadcast(pk);

        // Tokens with faucets. Faucet hands out 1000 USDC or 1 WETH per pull.
        TestToken usdc = new TestToken("Roque USD", "USDC", 6, 1_000e6);
        TestToken weth = new TestToken("Roque Wrapped Ether", "WETH", 18, 1e18);

        // Router and pool at 0.30 percent fee.
        DEXRouter router = new DEXRouter();
        LiquidityPool pool = new LiquidityPool(address(usdc), address(weth), 30);
        router.registerPool(address(usdc), address(weth), address(pool));

        // Order book on the live feed, executor on top, wired both ways.
        OrderBook orderBook = new OrderBook(address(router), SEPOLIA_ETH_USD);
        AgentExecutor executor = new AgentExecutor(address(router), address(orderBook));
        orderBook.setAgentExecutor(address(executor));

        // Register tokens with the executor so it can value trades in dollars.
        executor.registerToken(address(usdc), 6, true, address(0));
        executor.registerToken(address(weth), 18, false, SEPOLIA_ETH_USD);

        // Seed the pool so the app has depth to trade against on day one.
        usdc.mint(deployer, SEED_USDC);
        weth.mint(deployer, SEED_WETH);
        usdc.approve(address(pool), SEED_USDC);
        weth.approve(address(pool), SEED_WETH);
        (uint256 a0, uint256 a1) = address(usdc) < address(weth)
            ? (SEED_USDC, SEED_WETH)
            : (SEED_WETH, SEED_USDC);
        pool.addLiquidity(a0, a1, deployer);

        vm.stopBroadcast();

        _writeJson(deployer, agentSigner, usdc, weth, pool, router, orderBook, executor);

        console.log("USDC:         ", address(usdc));
        console.log("WETH:         ", address(weth));
        console.log("Pool:         ", address(pool));
        console.log("Router:       ", address(router));
        console.log("OrderBook:    ", address(orderBook));
        console.log("AgentExecutor:", address(executor));
    }

    function _writeJson(
        address deployer,
        address agentSigner,
        TestToken usdc,
        TestToken weth,
        LiquidityPool pool,
        DEXRouter router,
        OrderBook orderBook,
        AgentExecutor executor
    ) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "agentSigner", agentSigner);
        vm.serializeAddress(obj, "usdc", address(usdc));
        vm.serializeAddress(obj, "weth", address(weth));
        vm.serializeAddress(obj, "pool", address(pool));
        vm.serializeAddress(obj, "router", address(router));
        vm.serializeAddress(obj, "orderBook", address(orderBook));
        vm.serializeAddress(obj, "priceFeed", SEPOLIA_ETH_USD);
        string memory json = vm.serializeAddress(obj, "agentExecutor", address(executor));
        vm.writeJson(json, "./deployments/sepolia.json");
    }
}
