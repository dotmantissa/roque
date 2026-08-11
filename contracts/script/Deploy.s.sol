// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TestToken} from "../src/TestToken.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {DEXRouter} from "../src/DEXRouter.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {FaucetRouter} from "../src/FaucetRouter.sol";
import {IPriceFeed} from "../src/interfaces/IPriceFeed.sol";

/// @notice One shot deploy of the whole Roque stack to Sepolia: ten faucet
/// backed tokens, a full mesh of pools so any token trades directly into any
/// other, the router, the order book on the real Chainlink ETH/USD feed, the
/// agent executor, and the claim-all faucet helper. Every pool is seeded at the
/// live Chainlink price so the marginal price a user sees matches the dollar
/// value the executor enforces caps against. Addresses are written to
/// deployments/sepolia.json as parallel arrays the app and backend zip back up.
contract Deploy is Script {
    // Chainlink ETH/USD on Sepolia, 8 decimals. The order book still triggers on
    // this feed, so it stays a named constant.
    address constant SEPOLIA_ETH_USD = 0x694AA1769357215DE4FAC081bf1f309aDC325306;

    // Dollars of one token put into each side of each pool it belongs to.
    uint256 constant SEED_USD = 1_000_000;
    // Dollars handed out per faucet pull.
    uint256 constant FAUCET_USD = 1_000;
    // Every pool charges the same 0.30 percent.
    uint256 constant POOL_FEE_BPS = 30;

    struct Spec {
        string name;
        string symbol;
        uint8 decimals;
        bool isStable;
        address feed; // address(0) for a stable, priced at one dollar
    }

    // Working state, filled as we go.
    Spec[10] specs;
    uint256[10] price8; // each token's price in 8 decimal USD
    TestToken[10] token;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address agentSigner = vm.addr(vm.envUint("AGENT_SIGNER_PRIVATE_KEY"));

        console.log("Deployer:", deployer);
        console.log("Agent signer:", agentSigner);

        _loadSpecs();
        _readPrices();

        vm.startBroadcast(pk);

        // Shared plumbing first, so tokens can register against the executor.
        DEXRouter router = new DEXRouter();
        OrderBook orderBook = new OrderBook(address(router), SEPOLIA_ETH_USD);
        AgentExecutor executor = new AgentExecutor(address(router), address(orderBook));
        orderBook.setAgentExecutor(address(executor));

        // Deploy each token with a faucet worth about a thousand dollars, and
        // register it with the executor so trades can be valued in dollars.
        for (uint256 i = 0; i < 10; i++) {
            Spec memory s = specs[i];
            uint256 faucetAmt = _usdToTokens(FAUCET_USD, s.decimals, price8[i]);
            TestToken t = new TestToken(s.name, s.symbol, s.decimals, faucetAmt);
            token[i] = t;
            executor.registerToken(address(t), s.decimals, s.isStable, s.feed);
            console.log(s.symbol, address(t));
        }

        // The full mesh: one pool per unordered pair, seeded at the live price.
        FaucetRouter faucetRouter = new FaucetRouter();
        uint256 poolCount = _deployAndSeedPools(router, deployer);

        vm.stopBroadcast();

        _writeJson(deployer, agentSigner, router, orderBook, executor, faucetRouter);

        console.log("Pools deployed:", poolCount);
        console.log("Router:       ", address(router));
        console.log("OrderBook:    ", address(orderBook));
        console.log("AgentExecutor:", address(executor));
        console.log("FaucetRouter: ", address(faucetRouter));
    }

    // ─────────────────────────────────────────────────────────────
    // The ten assets. Stables are a flat dollar; the rest carry a real
    // Sepolia Chainlink feed, which is what lets the executor value them.
    // ─────────────────────────────────────────────────────────────
    function _loadSpecs() internal {
        specs[0] = Spec("Roque USD Coin", "rUSDC", 6, true, address(0));
        specs[1] = Spec("Roque Tether USD", "rUSDT", 6, true, address(0));
        specs[2] = Spec("Roque Dai", "rDAI", 18, true, address(0));
        specs[3] = Spec("Roque Wrapped Ether", "rWETH", 18, false, SEPOLIA_ETH_USD);
        specs[4] = Spec(
            "Roque Wrapped Bitcoin", "rWBTC", 8, false, 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43
        );
        specs[5] =
            Spec("Roque Chainlink", "rLINK", 18, false, 0xc59E3633BAAC79493d908e63626716e204A45EdF);
        specs[6] =
            Spec("Roque Synthetix", "rSNX", 18, false, 0xc0F82A46033b8BdBA4Bb0B0e28Bc2006F64355bC);
        specs[7] = Spec(
            "Roque Ampleforth", "rFORTH", 18, false, 0x070bF128E88A4520b3EfA65AB1e4Eb6F0F9E6632
        );
        specs[8] =
            Spec("Roque Euro Coin", "rEURC", 6, false, 0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910);
        specs[9] =
            Spec("Roque Gold", "rPAXG", 18, false, 0xC5981F461d74c46eB4b0CF3f4Ec79f025573B0Ea);
    }

    /// @dev A stable reads as exactly one dollar. Everything else is priced from
    /// its feed, normalised to 8 decimals so the seeding maths is uniform.
    function _readPrices() internal {
        for (uint256 i = 0; i < 10; i++) {
            Spec memory s = specs[i];
            if (s.isStable) {
                price8[i] = 1e8;
                continue;
            }
            (, int256 answer,,,) = IPriceFeed(s.feed).latestRoundData();
            require(answer > 0, "feed down");
            uint8 fd = IPriceFeed(s.feed).decimals();
            // The require above proves answer is strictly positive, so widening
            // it to uint256 cannot truncate or wrap.
            // forge-lint: disable-next-line(unsafe-typecast)
            price8[i] = (uint256(answer) * 1e8) / (10 ** uint256(fd));
            console.log(s.symbol, "price8:", price8[i]);
        }
    }

    /// @dev value(x raw) = x * price8 / (10^dec * 1e8) dollars, so to put
    /// `usdWhole` dollars into a token we invert: x = usdWhole * 1e8 * 10^dec / price8.
    function _usdToTokens(uint256 usdWhole, uint8 dec, uint256 p8) internal pure returns (uint256) {
        return (usdWhole * 1e8 * (10 ** uint256(dec))) / p8;
    }

    function _deployAndSeedPools(DEXRouter router, address deployer) internal returns (uint256 k) {
        for (uint256 i = 0; i < 10; i++) {
            for (uint256 j = i + 1; j < 10; j++) {
                LiquidityPool pool =
                    new LiquidityPool(address(token[i]), address(token[j]), POOL_FEE_BPS);
                router.registerPool(address(token[i]), address(token[j]), address(pool));

                uint256 amtI = _usdToTokens(SEED_USD, specs[i].decimals, price8[i]);
                uint256 amtJ = _usdToTokens(SEED_USD, specs[j].decimals, price8[j]);

                // Mint exactly what this pool needs and hand it over. Faucet
                // pulls mint fresh on demand, so no standing reserve is kept.
                token[i].mint(deployer, amtI);
                token[j].mint(deployer, amtJ);
                token[i].approve(address(pool), amtI);
                token[j].approve(address(pool), amtJ);

                // addLiquidity expects amounts in the pool's sorted token order.
                (uint256 a0, uint256 a1) =
                    address(token[i]) < address(token[j]) ? (amtI, amtJ) : (amtJ, amtI);
                pool.addLiquidity(a0, a1, deployer);

                _poolA[k] = specs[i].symbol;
                _poolB[k] = specs[j].symbol;
                _poolAddr[k] = address(pool);
                k++;
            }
        }
    }

    // Parallel arrays for the pool mesh, filled during seeding.
    string[45] private _poolA;
    string[45] private _poolB;
    address[45] private _poolAddr;

    function _writeJson(
        address deployer,
        address agentSigner,
        DEXRouter router,
        OrderBook orderBook,
        AgentExecutor executor,
        FaucetRouter faucetRouter
    ) internal {
        // Token side: parallel arrays keyed the same, so the app can zip them.
        string[] memory tSym = new string[](10);
        string[] memory tName = new string[](10);
        address[] memory tAddr = new address[](10);
        uint256[] memory tDec = new uint256[](10);
        bool[] memory tStable = new bool[](10);
        address[] memory tFeed = new address[](10);
        uint256[] memory tPrice = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            tSym[i] = specs[i].symbol;
            tName[i] = specs[i].name;
            tAddr[i] = address(token[i]);
            tDec[i] = specs[i].decimals;
            tStable[i] = specs[i].isStable;
            tFeed[i] = specs[i].feed;
            tPrice[i] = price8[i];
        }

        string[] memory pA = new string[](45);
        string[] memory pB = new string[](45);
        address[] memory pAddr = new address[](45);
        for (uint256 k = 0; k < 45; k++) {
            pA[k] = _poolA[k];
            pB[k] = _poolB[k];
            pAddr[k] = _poolAddr[k];
        }

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "deployer", deployer);
        vm.serializeAddress(o, "agentSigner", agentSigner);
        vm.serializeAddress(o, "router", address(router));
        vm.serializeAddress(o, "orderBook", address(orderBook));
        vm.serializeAddress(o, "agentExecutor", address(executor));
        vm.serializeAddress(o, "faucetRouter", address(faucetRouter));
        vm.serializeAddress(o, "priceFeed", SEPOLIA_ETH_USD);
        vm.serializeString(o, "tokenSymbols", tSym);
        vm.serializeString(o, "tokenNames", tName);
        vm.serializeAddress(o, "tokenAddresses", tAddr);
        vm.serializeUint(o, "tokenDecimals", tDec);
        vm.serializeBool(o, "tokenIsStable", tStable);
        vm.serializeAddress(o, "tokenFeeds", tFeed);
        vm.serializeUint(o, "tokenPrice8", tPrice);
        vm.serializeString(o, "poolA", pA);
        vm.serializeString(o, "poolB", pB);
        string memory json = vm.serializeAddress(o, "poolAddresses", pAddr);
        vm.writeJson(json, "./deployments/sepolia.json");
    }
}
