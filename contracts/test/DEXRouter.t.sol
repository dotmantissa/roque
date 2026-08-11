// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {DEXRouter} from "../src/DEXRouter.sol";

contract DEXRouterTest is Base {
    function test_QuoteMatchesPool() public view {
        uint256 viaRouter = router.quoteSwap(address(usdc), address(weth), 2_500e6);
        uint256 viaPool = pool.getAmountOut(address(usdc), 2_500e6);
        assertEq(viaRouter, viaPool);
    }

    function test_SwapThroughRouter() public {
        usdc.mint(alice, 5_000e6);
        uint256 expected = router.quoteSwap(address(usdc), address(weth), 5_000e6);

        vm.startPrank(alice);
        usdc.approve(address(router), 5_000e6);
        uint256 out = router.swapExactTokensForTokens(
            address(usdc), address(weth), 5_000e6, expected, alice, block.timestamp + 1
        );
        vm.stopPrank();

        assertEq(out, expected);
        assertEq(weth.balanceOf(alice), expected);
    }

    function test_SwapRevertsPastDeadline() public {
        usdc.mint(alice, 5_000e6);
        vm.startPrank(alice);
        usdc.approve(address(router), 5_000e6);
        vm.warp(1_000);
        vm.expectRevert(DEXRouter.DeadlinePassed.selector);
        router.swapExactTokensForTokens(address(usdc), address(weth), 5_000e6, 0, alice, 999);
        vm.stopPrank();
    }

    function test_SwapRevertsWithoutPool() public {
        vm.expectRevert(DEXRouter.NoPoolForPair.selector);
        router.quoteSwap(address(usdc), address(0xdead), 1e6);
    }

    function test_PoolLookupIsOrderIndependent() public view {
        assertEq(
            router.poolFor(address(usdc), address(weth)),
            router.poolFor(address(weth), address(usdc))
        );
    }

    function test_OnlyOwnerRegistersPool() public {
        vm.prank(alice);
        vm.expectRevert();
        router.registerPool(address(usdc), address(weth), address(pool));
    }
}
