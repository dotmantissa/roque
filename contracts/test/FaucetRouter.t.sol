// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/TestToken.sol";
import {FaucetRouter} from "../src/FaucetRouter.sol";

/// @notice Proves the claim-all helper pulls every listed faucet in one call,
/// credits the caller (not the router), and quietly skips tokens the caller has
/// already exhausted instead of reverting the whole batch.
contract FaucetRouterTest is Test {
    FaucetRouter internal faucetRouter;
    TestToken internal usdc;
    TestToken internal weth;
    TestToken internal wbtc;
    address internal bob = makeAddr("bob");

    address[] internal tokens;

    function setUp() public {
        faucetRouter = new FaucetRouter();
        usdc = new TestToken("Roque USD", "rUSDC", 6, 1_000e6);
        weth = new TestToken("Roque Wrapped Ether", "rWETH", 18, 5e17);
        wbtc = new TestToken("Roque Wrapped Bitcoin", "rWBTC", 8, 1e6);
        tokens = [address(usdc), address(weth), address(wbtc)];
    }

    function test_ClaimAllCreditsCaller() public {
        vm.prank(bob);
        uint256 succeeded = faucetRouter.claimAll(tokens);

        assertEq(succeeded, 3);
        assertEq(usdc.balanceOf(bob), 1_000e6);
        assertEq(weth.balanceOf(bob), 5e17);
        assertEq(wbtc.balanceOf(bob), 1e6);
        // The router itself must never end up holding tokens.
        assertEq(usdc.balanceOf(address(faucetRouter)), 0);
    }

    function test_ClaimAllCountsAgainstReceiver() public {
        vm.prank(bob);
        faucetRouter.claimAll(tokens);
        // Going through the router consumes one of bob's five pulls per token,
        // exactly as if he had called each faucet himself.
        assertEq(usdc.claimsRemaining(bob), 4);
        assertEq(weth.claimsRemaining(bob), 4);
        assertEq(wbtc.claimsRemaining(bob), 4);
    }

    function test_ClaimAllSkipsExhausted() public {
        // Exhaust usdc for bob directly, leaving the other two claimable.
        vm.startPrank(bob);
        for (uint256 i = 0; i < 5; i++) {
            usdc.faucet();
        }

        uint256 succeeded = faucetRouter.claimAll(tokens);
        vm.stopPrank();

        // usdc is maxed, so only weth and wbtc pay out.
        assertEq(succeeded, 2);
        assertEq(usdc.balanceOf(bob), 5_000e6); // unchanged beyond the five direct pulls
        assertEq(weth.balanceOf(bob), 5e17);
        assertEq(wbtc.balanceOf(bob), 1e6);
    }

    function test_ClaimableCountReflectsRemaining() public {
        assertEq(faucetRouter.claimableCount(bob, tokens), 3);

        vm.startPrank(bob);
        for (uint256 i = 0; i < 5; i++) {
            usdc.faucet();
        }
        vm.stopPrank();

        assertEq(faucetRouter.claimableCount(bob, tokens), 2);
    }
}
