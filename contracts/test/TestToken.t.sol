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
        assertEq(token.MAX_CLAIMS(), 5);
    }

    function test_FaucetMintsStandardAmount() public {
        vm.prank(bob);
        token.faucet();
        assertEq(token.balanceOf(bob), 1_000e6);
        assertEq(token.claimCount(bob), 1);
    }

    function test_FaucetToSeedsAnotherAddress() public {
        vm.prank(bob);
        token.faucetTo(alice());
        // The cap follows the receiver, not the caller.
        assertEq(token.balanceOf(alice()), 1_000e6);
        assertEq(token.claimCount(alice()), 1);
        assertEq(token.claimCount(bob), 0);
    }

    function test_FaucetAllowsUpToMaxClaims() public {
        vm.startPrank(bob);
        for (uint256 i = 0; i < 5; i++) {
            token.faucet();
        }
        vm.stopPrank();
        assertEq(token.balanceOf(bob), 5_000e6);
        assertEq(token.claimsRemaining(bob), 0);
    }

    function test_FaucetRevertsOnceExhausted() public {
        vm.startPrank(bob);
        for (uint256 i = 0; i < 5; i++) {
            token.faucet();
        }
        vm.expectRevert(abi.encodeWithSelector(TestToken.FaucetExhausted.selector, bob));
        token.faucet();
        vm.stopPrank();
    }

    function test_ClaimsRemainingCountsDown() public {
        assertEq(token.claimsRemaining(bob), 5);
        vm.startPrank(bob);
        token.faucet();
        assertEq(token.claimsRemaining(bob), 4);
        token.faucet();
        assertEq(token.claimsRemaining(bob), 3);
        vm.stopPrank();
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

    function testFuzz_NeverExceedsMaxClaims(uint256 pulls) public {
        pulls = bound(pulls, 0, 20);
        vm.startPrank(bob);
        uint256 succeeded;
        for (uint256 i = 0; i < pulls; i++) {
            try token.faucet() {
                succeeded++;
            } catch {}
        }
        vm.stopPrank();
        uint256 expected = pulls > 5 ? 5 : pulls;
        assertEq(succeeded, expected);
        assertEq(token.claimCount(bob), expected);
    }

    function alice() internal pure returns (address) {
        return address(0xA11CE);
    }
}
