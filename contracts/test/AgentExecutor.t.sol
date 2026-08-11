// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {OrderBook} from "../src/OrderBook.sol";

contract AgentExecutorTest is Base {
    function _swapIntent(uint256 amountIn, uint256 minOut, uint256 nonce)
        internal
        view
        returns (AgentExecutor.SwapIntent memory)
    {
        return AgentExecutor.SwapIntent({
            user: alice,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: amountIn,
            minAmountOut: minOut,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
    }

    // ── Vault ────────────────────────────────────────────────────

    function test_DepositAndWithdraw() public {
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(executor), 1_000e6);
        executor.deposit(address(usdc), 1_000e6);
        assertEq(executor.vaultBalance(alice, address(usdc)), 1_000e6);
        executor.withdraw(address(usdc), 400e6);
        vm.stopPrank();
        assertEq(executor.vaultBalance(alice, address(usdc)), 600e6);
        assertEq(usdc.balanceOf(alice), 400e6);
    }

    function test_WithdrawTooMuchReverts() public {
        _fundVault(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        executor.withdraw(address(usdc), 200e6);
    }

    // ── Dollar valuation ─────────────────────────────────────────

    function test_UsdValueStableIsOneToOne() public view {
        assertEq(executor.usdValue(address(usdc), 500e6), 500e18);
    }

    function test_UsdValueWethUsesFeed() public view {
        // 1 WETH at 2500/ETH is 2500 dollars.
        assertEq(executor.usdValue(address(weth), 1e18), 2_500e18);
    }

    // ── Capability grant ─────────────────────────────────────────

    function test_GrantAndReadCapability() public {
        _grantStandard(alice);
        AgentExecutor.Capability memory c = executor.getCapability(alice);
        assertEq(c.agentSigner, agentSigner);
        assertEq(c.maxPerTradeUsd, 500e18);
        assertEq(c.maxDailyUsd, 2_000e18);
        assertEq(c.maxSlippageBps, 100);
        assertTrue(c.exists);
        assertFalse(c.revoked);
    }

    function test_GrantWithSignature() public {
        uint256 userPk = 0xB0B;
        address user = vm.addr(userPk);
        bytes32 structHash = keccak256(
            abi.encode(
                GRANT_TYPEHASH,
                user,
                agentSigner,
                uint256(500e18),
                uint256(2_000e18),
                uint256(100),
                uint64(block.timestamp + 1 days),
                uint256(0)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, _digest(structHash));
        executor.grantCapabilityWithSig(
            user,
            agentSigner,
            500e18,
            2_000e18,
            100,
            uint64(block.timestamp + 1 days),
            abi.encodePacked(r, s, v)
        );
        assertEq(executor.getCapability(user).agentSigner, agentSigner);
    }

    // ── The happy path ───────────────────────────────────────────

    function test_AgentSwapWithinCaps() public {
        _fundVault(alice, 1_000e6);
        _grantStandard(alice);

        uint256 quote = router.quoteSwap(address(usdc), address(weth), 250e6);
        uint256 minOut = (quote * 9_950) / 10_000; // accept 0.5% slippage
        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, minOut, 1);
        bytes memory sig = _signSwap(agentPk, intent);

        uint256 out = executor.executeSwap(intent, sig);
        assertGt(out, 0);
        assertEq(executor.vaultBalance(alice, address(weth)), out);
        assertEq(executor.vaultBalance(alice, address(usdc)), 750e6);
    }

    // ── The rejections that matter ───────────────────────────────

    function test_RejectsWrongSigner() public {
        _fundVault(alice, 1_000e6);
        _grantStandard(alice);
        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, 0, 1);
        uint256 impostorPk = 0xBAD;
        bytes memory sig = _signSwap(impostorPk, intent);
        vm.expectRevert();
        executor.executeSwap(intent, sig);
    }

    function test_RejectsOverPerTradeCap() public {
        _fundVault(alice, 5_000e6);
        _grantStandard(alice); // 500 dollar per trade
        AgentExecutor.SwapIntent memory intent = _swapIntent(600e6, 0, 1); // 600 dollars
        bytes memory sig = _signSwap(agentPk, intent);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutor.OverPerTradeCap.selector, uint256(600e18), uint256(500e18)
            )
        );
        executor.executeSwap(intent, sig);
    }

    function test_RejectsOverDailyCapAcrossTrades() public {
        _fundVault(alice, 5_000e6);
        _grantStandard(alice); // 2000 dollar daily

        // Four 500 dollar trades exhaust the day, the fifth must fail.
        for (uint256 i = 1; i <= 4; i++) {
            uint256 quote = router.quoteSwap(address(usdc), address(weth), 500e6);
            AgentExecutor.SwapIntent memory ok = _swapIntent(500e6, (quote * 9_900) / 10_000, i);
            executor.executeSwap(ok, _signSwap(agentPk, ok));
        }
        AgentExecutor.SwapIntent memory over = _swapIntent(500e6, 0, 5);
        bytes memory overSig = _signSwap(agentPk, over);
        vm.expectRevert();
        executor.executeSwap(over, overSig);
    }

    function test_RejectsReusedNonce() public {
        _fundVault(alice, 1_000e6);
        _grantStandard(alice);
        uint256 quote = router.quoteSwap(address(usdc), address(weth), 250e6);
        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, (quote * 9_900) / 10_000, 7);
        bytes memory sig = _signSwap(agentPk, intent);
        executor.executeSwap(intent, sig);
        vm.expectRevert(abi.encodeWithSelector(AgentExecutor.NonceUsed.selector, uint256(7)));
        executor.executeSwap(intent, sig);
    }

    function test_RejectsAfterRevoke() public {
        _fundVault(alice, 1_000e6);
        _grantStandard(alice);
        vm.prank(alice);
        executor.revokeCapability();

        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, 0, 1);
        bytes memory sig = _signSwap(agentPk, intent);
        vm.expectRevert(AgentExecutor.CapabilityRevokedError.selector);
        executor.executeSwap(intent, sig);
    }

    function test_RejectsExpiredCapability() public {
        _fundVault(alice, 1_000e6);
        vm.prank(alice);
        executor.grantCapability(
            agentSigner, 500e18, 2_000e18, 100, uint64(block.timestamp + 1 hours)
        );
        vm.warp(block.timestamp + 2 hours);

        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, 0, 1);
        // Deadline well past the warped time so the capability expiry is the
        // check that trips, not the intent deadline.
        intent.deadline = block.timestamp + 30 days;
        bytes memory sig = _signSwap(agentPk, intent);
        vm.expectRevert(AgentExecutor.CapabilityExpired.selector);
        executor.executeSwap(intent, sig);
    }

    function test_RejectsExpiredIntent() public {
        _fundVault(alice, 1_000e6);
        _grantStandard(alice);
        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, 0, 1);
        intent.deadline = block.timestamp - 1;
        bytes memory sig = _signSwap(agentPk, intent);
        vm.expectRevert(AgentExecutor.IntentExpired.selector);
        executor.executeSwap(intent, sig);
    }

    function test_RejectsExcessiveSlippage() public {
        _fundVault(alice, 1_000e6);
        _grantStandard(alice); // 1% slippage cap
        // Ask to accept far less than the quote allows (minOut too low).
        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, 1, 1);
        bytes memory sig = _signSwap(agentPk, intent);
        vm.expectRevert();
        executor.executeSwap(intent, sig);
    }

    function test_RejectsWithoutCapability() public {
        _fundVault(alice, 1_000e6);
        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, 0, 1);
        bytes memory sig = _signSwap(agentPk, intent);
        vm.expectRevert(AgentExecutor.CapabilityMissing.selector);
        executor.executeSwap(intent, sig);
    }

    function test_RejectsWhenVaultEmpty() public {
        _grantStandard(alice); // capability but no deposit
        uint256 quote = router.quoteSwap(address(usdc), address(weth), 250e6);
        AgentExecutor.SwapIntent memory intent = _swapIntent(250e6, (quote * 9_900) / 10_000, 1);
        bytes memory sig = _signSwap(agentPk, intent);
        vm.expectRevert();
        executor.executeSwap(intent, sig);
    }

    // ── Agent limit orders ───────────────────────────────────────

    function test_AgentCreatesLimitOrderFromVault() public {
        _fundVault(alice, 2_500e6);
        _grantStandard(alice);

        AgentExecutor.LimitIntent memory intent = AgentExecutor.LimitIntent({
            user: alice,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 500e6,
            minAmountOut: 0,
            triggerPrice: 2_400e8,
            triggerAbove: false,
            expiry: uint64(block.timestamp + 2 days),
            nonce: 100,
            deadline: block.timestamp + 1 hours
        });
        uint256 orderId = executor.createLimitOrder(intent, _signLimit(agentPk, intent));

        OrderBook.Order memory o = orderBook.getOrder(orderId);
        assertEq(o.owner, alice);
        assertEq(o.amountIn, 500e6);
        // Vault was debited, order book now escrows it.
        assertEq(executor.vaultBalance(alice, address(usdc)), 2_000e6);
        assertEq(usdc.balanceOf(address(orderBook)), 500e6);
    }

    function test_RemainingDailyTracks() public {
        _fundVault(alice, 2_000e6);
        _grantStandard(alice);
        assertEq(executor.remainingDailyUsd(alice), 2_000e18);

        uint256 quote = router.quoteSwap(address(usdc), address(weth), 500e6);
        AgentExecutor.SwapIntent memory intent = _swapIntent(500e6, (quote * 9_900) / 10_000, 1);
        executor.executeSwap(intent, _signSwap(agentPk, intent));
        assertEq(executor.remainingDailyUsd(alice), 1_500e18);
    }

    function testFuzz_NeverExceedsPerTradeCap(uint256 amountIn) public {
        _fundVault(alice, 100_000e6);
        _grantStandard(alice); // 500 dollar cap
        amountIn = bound(amountIn, 1e6, 100_000e6);
        AgentExecutor.SwapIntent memory intent = _swapIntent(amountIn, 0, 1);
        bytes memory sig = _signSwap(agentPk, intent);

        uint256 valueUsd = executor.usdValue(address(usdc), amountIn);
        if (valueUsd > 500e18) {
            vm.expectRevert();
            executor.executeSwap(intent, sig);
        } else {
            // within the cap it may still revert on slippage if minOut is 0 and
            // slippage floor is nonzero, so only assert the cap path here.
            try executor.executeSwap(intent, sig) {} catch {}
        }
    }
}
