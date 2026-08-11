// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/TestToken.sol";

contract TestTokenTest is Test {
    TestToken internal token;
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new TestToken("Roque USD", "USDC", 6, 1_000e6);
    }

    function test_MetadataMatchesConstructor() public view {
        assertEq(token.name(), "Roque USD");
        assertEq(token.symbol(), "USDC");
        assertEq(token.decimals(), 6);
        assertEq(token.faucetAmount(), 1_000e6);
    }

    function test_FaucetMintsStandardAmount() public {
        vm.prank(bob);
        token.faucet();
        assertEq(token.balanceOf(bob), 1_000e6);
    }

    function test_FaucetToSeedsAnotherAddress() public {
        vm.prank(bob);
        token.faucetTo(alice());
        assertEq(token.balanceOf(alice()), 1_000e6);
    }

    function test_FaucetRevertsWhileOnCooldown() public {
        vm.startPrank(bob);
        token.faucet();
        vm.expectRevert();
        token.faucet();
        vm.stopPrank();
    }

    function test_FaucetWorksAgainAfterCooldown() public {
        vm.startPrank(bob);
        token.faucet();
        vm.warp(block.timestamp + token.FAUCET_COOLDOWN());
        token.faucet();
        vm.stopPrank();
        assertEq(token.balanceOf(bob), 2_000e6);
    }

    function test_OwnerCanMint() public {
        token.mint(bob, 5_000e6);
        assertEq(token.balanceOf(bob), 5_000e6);
    }

    function test_NonOwnerCannotMint() public {
        vm.prank(bob);
        vm.expectRevert();
        token.mint(bob, 5_000e6);
    }

    function testFuzz_FaucetCooldownBoundary(uint256 wait) public {
        wait = bound(wait, 0, token.FAUCET_COOLDOWN() - 1);
        vm.startPrank(bob);
        token.faucet();
        vm.warp(block.timestamp + wait);
        vm.expectRevert();
        token.faucet();
        vm.stopPrank();
    }

    function alice() internal pure returns (address) {
        return address(0xA11CE);
    }
}
