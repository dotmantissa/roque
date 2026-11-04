// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

/// @notice Stage an executor v2 against the existing router and OrderBook.
/// The default preserves live OrderBook authority. EXECUTOR_CUTOVER explicitly
/// opts into switching it. Owner withdrawals and commitment exits remain in
/// previous vaults; no balances, holds or signatures migrate automatically.
/// Prefer packages/core/scripts/release.ts for a recoverable production release
/// with a private signed-transaction journal and verified versioned metadata.
contract UpgradeExecutor is Script {
    string constant REGISTRY = "deployments/sepolia.json";

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        string memory json = vm.readFile(REGISTRY);
        address router = vm.parseJsonAddress(json, ".router");
        address payable orderBook = payable(vm.parseJsonAddress(json, ".orderBook"));
        address previous = vm.parseJsonAddress(json, ".agentExecutor");

        address[] memory tokens = vm.parseJsonAddressArray(json, ".tokenAddresses");
        uint256[] memory decimals = vm.parseJsonUintArray(json, ".tokenDecimals");
        bool[] memory isStable = vm.parseJsonBoolArray(json, ".tokenIsStable");
        address[] memory feeds = vm.parseJsonAddressArray(json, ".tokenFeeds");

        console.log("Deployer:   ", deployer);
        console.log("Router:     ", router);
        console.log("OrderBook:  ", orderBook);
        console.log("Replacing:  ", previous);
        require(tokens.length == decimals.length, "registry token arrays disagree");
        require(tokens.length == isStable.length, "registry token arrays disagree");
        require(tokens.length == feeds.length, "registry token arrays disagree");

        vm.startBroadcast(pk);

        AgentExecutor executor = new AgentExecutor(router, orderBook);
        for (uint256 i = 0; i < tokens.length; i++) {
            executor.registerToken(tokens[i], uint8(decimals[i]), isStable[i], feeds[i]);
        }
        // A staged executor cannot place agent limits until the shared book switches.
        // Stage by default; switch the shared order book only during the coordinated cutover.
        if (vm.envOr("EXECUTOR_CUTOVER", false)) {
            OrderBook(orderBook).setAgentExecutor(address(executor));
        }

        vm.stopBroadcast();

        vm.writeJson(vm.toString(previous), REGISTRY, ".previousAgentExecutor");
        vm.writeJson(vm.toString(address(executor)), REGISTRY, ".agentExecutor");
        vm.writeJson('"2"', REGISTRY, ".executorDomainVersion");

        console.log("AgentExecutor:", address(executor));
        console.log("Tokens registered:", tokens.length);
    }
}
