// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";

contract LiquidityPoolTest is Base {
    function test_SeededReservesAndPrice() public view {
        (uint256 r0, uint256 r1) = pool.getReserves();
        // token0/token1 ordering is by address, so map back to real reserves.
        (uint256 usdcReserve, uint256 wethReserve) =
            address(usdc) < address(weth) ? (r0, r1) : (r1, r0);
        assertEq(usdcReserve, 2_500_000e6);
        assertEq(wethReserve, 1_000e18);
    }

    function test_InitialProviderGotShares() public view {
        assertGt(pool.sharesOf(liquidityProvider), 0);
        assertEq(pool.totalShares(), pool.sharesOf(liquidityProvider) + pool.MINIMUM_LIQUIDITY());
    }

    function test_QuoteRoughlyMatchesSpotMinusFee() public view {
        // Selling 2500 USDC should return a touch under 1 WETH after the 0.3% fee
        // and price impact.
        uint256 out = pool.getAmountOut(address(usdc), 2_500e6);
        assertLt(out, 1e18);
        assertGt(out, 0.98e18);
    }

    function test_SwapUsdcForWeth() public {
        usdc.mint(alice, 2_500e6);
        uint256 expected = pool.getAmountOut(address(usdc), 2_500e6);

        vm.startPrank(alice);
        usdc.approve(address(pool), 2_500e6);
        uint256 out = pool.swap(address(usdc), 2_500e6, expected, alice);
        vm.stopPrank();

        assertEq(out, expected);
        assertEq(weth.balanceOf(alice), expected);
    }

    function test_SwapRespectsSlippageFloor() public {
        usdc.mint(alice, 2_500e6);
        uint256 expected = pool.getAmountOut(address(usdc), 2_500e6);
        vm.startPrank(alice);
        usdc.approve(address(pool), 2_500e6);
        vm.expectRevert(LiquidityPool.InsufficientOutput.selector);
        pool.swap(address(usdc), 2_500e6, expected + 1, alice);
        vm.stopPrank();
    }

    function test_ConstantProductHoldsOrGrows() public {
        (uint256 r0Before, uint256 r1Before) = pool.getReserves();
        uint256 kBefore = r0Before * r1Before;

        usdc.mint(alice, 10_000e6);
        vm.startPrank(alice);
        usdc.approve(address(pool), 10_000e6);
        pool.swap(address(usdc), 10_000e6, 0, alice);
        vm.stopPrank();

        (uint256 r0After, uint256 r1After) = pool.getReserves();
        // The fee makes k strictly grow across a swap.
        assertGe(r0After * r1After, kBefore);
    }

    function test_AddThenRemoveLiquidityReturnsFunds() public {
        usdc.mint(alice, 25_000e6);
        weth.mint(alice, 10e18);

        (uint256 amount0, uint256 amount1) = _sortedAmounts(25_000e6, 10e18);
        vm.startPrank(alice);
        usdc.approve(address(pool), type(uint256).max);
        weth.approve(address(pool), type(uint256).max);
        (,, uint256 shares) = pool.addLiquidity(amount0, amount1, alice);
        assertGt(shares, 0);

        (uint256 out0, uint256 out1) = pool.removeLiquidity(shares, alice);
        vm.stopPrank();

        assertGt(out0, 0);
        assertGt(out1, 0);
        assertEq(pool.sharesOf(alice), 0);
    }

    function test_AddLiquidityKeepsRatio() public {
        // Offer a lopsided deposit; the pool should only take the balanced slice.
        usdc.mint(alice, 25_000e6);
        weth.mint(alice, 100e18);
        (uint256 amount0, uint256 amount1) = _sortedAmounts(25_000e6, 100e18);
        vm.startPrank(alice);
        usdc.approve(address(pool), type(uint256).max);
        weth.approve(address(pool), type(uint256).max);
        (uint256 a0, uint256 a1,) = pool.addLiquidity(amount0, amount1, alice);
        vm.stopPrank();

        // At 2500 per eth, 25,000 USDC pairs with 10 WETH, not 100.
        (uint256 usdcUsed, uint256 wethUsed) = address(usdc) < address(weth) ? (a0, a1) : (a1, a0);
        assertEq(usdcUsed, 25_000e6);
        assertApproxEqAbs(wethUsed, 10e18, 1e15);
    }

    function test_SwapUnknownTokenReverts() public {
        vm.expectRevert(LiquidityPool.WrongToken.selector);
        pool.swap(address(0xdead), 1e18, 0, alice);
    }

    function testFuzz_SwapNeverReturnsMoreThanReserve(uint256 amountIn) public view {
        amountIn = bound(amountIn, 1e6, 1_000_000e6);
        (uint256 r0, uint256 r1) = pool.getReserves();
        uint256 wethReserve = address(usdc) < address(weth) ? r1 : r0;
        uint256 out = pool.getAmountOut(address(usdc), amountIn);
        assertLt(out, wethReserve);
    }
}
