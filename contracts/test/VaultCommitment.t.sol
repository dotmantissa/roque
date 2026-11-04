// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";
import {OrderBook} from "../src/OrderBook.sol";

/// @notice Commitments: vault money promised to a resting order, and what that
/// forbids.
///
/// The bug these exist to kill had two doors and only one of them was ever
/// shut. A database row stopped the app's own withdraw button, so the obvious
/// attempt failed. Everything else walked straight through: the same balance
/// could be spent by an ordinary autonomous trade, turned into another token the
/// ledger had never heard of, and withdrawn clean while the event order still
/// sat there armed and watching. The money was gone and the order did not find
/// out until its condition came true weeks later.
///
/// So most of what follows asserts an absence. No withdrawal into a hold, no
/// ordinary trade reaching past one, no second commitment on the same deposit,
/// and the matching half that stops this from being a trap: no hold that cannot
/// be ended by the person whose money it is.
contract VaultCommitmentTest is Base {
    bytes32 internal constant EO_1 = keccak256("event_order:eo-1:0");
    bytes32 internal constant EO_2 = keccak256("event_order:eo-2:0");

    /// @dev Room enough that the dollar caps are never the thing under test.
    function _grantLarge(address user) internal {
        vm.prank(user);
        executor.grantCapability(
            agentSigner, 100_000e18, 1_000_000e18, 500, uint64(block.timestamp + 30 days)
        );
    }

    function _swap(address user, uint256 amountIn, bytes32 id, uint256 nonce)
        internal
        returns (AgentExecutor.SwapIntent memory intent, bytes memory sig)
    {
        uint256 quote = router.quoteSwap(address(usdc), address(weth), amountIn);
        intent = AgentExecutor.SwapIntent({
            user: user,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: amountIn,
            minAmountOut: (quote * 9_950) / 10_000,
            commitmentId: id,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
        sig = _signSwap(agentPk, intent);
    }

    function setUp() public override {
        super.setUp();
        _fundVault(alice, 1_000e6);
        _grantLarge(alice);
    }

    // ── What a lock does, and does not, move ─────────────────────

    function test_LockHoldsWithoutMovingTheBalance() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        assertEq(executor.vaultBalance(alice, address(usdc)), 1_000e6, "balance untouched");
        assertEq(executor.lockedBalance(alice, address(usdc)), 800e6);
        assertEq(executor.availableBalance(alice, address(usdc)), 200e6);

        AgentExecutor.Commitment memory c = executor.getCommitment(EO_1);
        assertEq(c.user, alice);
        assertEq(c.token, address(usdc));
        assertEq(c.amount, 800e6);
        assertEq(c.epoch, 1);
        assertTrue(c.active);
    }

    // ── Door one: the withdrawal ─────────────────────────────────

    function test_WithdrawCannotReachACommitment() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutor.CommittedVault.selector,
                uint256(200e6),
                uint256(500e6),
                uint256(800e6)
            )
        );
        executor.withdraw(address(usdc), 500e6);
    }

    function test_WithdrawTakesTheFreePartHappily() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        vm.prank(alice);
        executor.withdraw(address(usdc), 200e6);
        assertEq(executor.vaultBalance(alice, address(usdc)), 800e6);
        assertEq(usdc.balanceOf(alice), 200e6);
        // Still fully committed, and now there is nothing beside it.
        assertEq(executor.availableBalance(alice, address(usdc)), 0);
    }

    // ── Door two: the trade that used to walk it out ─────────────

    function test_OrdinaryTradeCannotSpendACommitment() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) =
            _swap(alice, 500e6, bytes32(0), 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutor.CommittedVault.selector,
                uint256(200e6),
                uint256(500e6),
                uint256(800e6)
            )
        );
        executor.executeSwap(intent, sig);
    }

    /// The whole escape, run end to end: spend the committed rUSDC on rWETH the
    /// hold knows nothing about, then withdraw the rWETH. Both halves must fail.
    function test_CommittedMoneyCannotBeLaunderedThroughAnotherToken() public {
        _commit(alice, address(usdc), 1_000e6, EO_1, 1);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) =
            _swap(alice, 1_000e6, bytes32(0), 2);
        vm.expectRevert();
        executor.executeSwap(intent, sig);
        assertEq(executor.vaultBalance(alice, address(weth)), 0, "no rWETH was ever minted for it");
        assertEq(executor.vaultBalance(alice, address(usdc)), 1_000e6);
    }

    function test_OrdinaryTradeStillSpendsTheFreePart() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) =
            _swap(alice, 200e6, bytes32(0), 2);
        uint256 out = executor.executeSwap(intent, sig);
        assertGt(out, 0);
        assertEq(executor.vaultBalance(alice, address(usdc)), 800e6);
        assertEq(executor.lockedBalance(alice, address(usdc)), 800e6, "hold survived the trade");
    }

    // ── Spending the commitment it was set aside for ─────────────

    function test_NamedCommitmentIsSpentAndTheHoldClears() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) = _swap(alice, 800e6, EO_1, 2);
        executor.executeSwap(intent, sig);

        assertEq(executor.vaultBalance(alice, address(usdc)), 200e6);
        assertEq(executor.lockedBalance(alice, address(usdc)), 0);
        assertFalse(executor.getCommitment(EO_1).active);
        // And the rest of the vault is free again.
        vm.prank(alice);
        executor.withdraw(address(usdc), 200e6);
    }

    /// A percentage order sizes itself at fire time, so the fill can come in
    /// under what was held. The leftover must not stay locked.
    function test_FillSmallerThanItsHoldReleasesTheRemainder() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) = _swap(alice, 300e6, EO_1, 2);
        executor.executeSwap(intent, sig);
        assertEq(executor.lockedBalance(alice, address(usdc)), 0, "no locked dust left behind");
        assertEq(executor.availableBalance(alice, address(usdc)), 700e6);
    }

    /// And it can come in over, so long as the difference is genuinely free.
    function test_FillLargerThanItsHoldDrawsTheRestFromFree() public {
        _commit(alice, address(usdc), 600e6, EO_1, 1);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) = _swap(alice, 900e6, EO_1, 2);
        executor.executeSwap(intent, sig);
        assertEq(executor.vaultBalance(alice, address(usdc)), 100e6);
        assertEq(executor.lockedBalance(alice, address(usdc)), 0);
    }

    function test_FillOverTheWholeVaultStillReverts() public {
        _commit(alice, address(usdc), 600e6, EO_1, 1);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) = _swap(alice, 1_200e6, EO_1, 2);
        vm.expectRevert();
        executor.executeSwap(intent, sig);
    }

    function test_LimitOrderSpendsItsCommitment() public {
        _commit(alice, address(usdc), 500e6, EO_1, 1);
        AgentExecutor.LimitIntent memory intent = AgentExecutor.LimitIntent({
            user: alice,
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 500e6,
            minAmountOut: router.quoteSwap(address(usdc), address(weth), 500e6) * 9900 / 10000,
            triggerPrice: 2_400e8,
            triggerAbove: false,
            expiry: uint64(block.timestamp + 2 days),
            commitmentId: EO_1,
            nonce: 2,
            deadline: block.timestamp + 1 hours
        });
        uint256 orderId = executor.createLimitOrder(intent, _signLimit(agentPk, intent));
        OrderBook.Order memory o = orderBook.getOrder(orderId);
        assertEq(o.owner, alice);
        assertEq(executor.lockedBalance(alice, address(usdc)), 0);
        assertEq(executor.vaultBalance(alice, address(usdc)), 500e6);
    }

    // ── One deposit cannot back two orders ───────────────────────

    function test_SecondCommitmentCannotClaimTheSameMoney() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        AgentExecutor.CommitIntent memory intent = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 800e6,
            unlockAt: uint64(block.timestamp + 14 days),
            commitmentId: EO_2,
            nonce: 2,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig1 = _signCommit(agentPk, intent);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutor.CommittedVault.selector,
                uint256(200e6),
                uint256(800e6),
                uint256(800e6)
            )
        );
        executor.lockForCommitment(intent, sig1);
    }

    function test_TwoCommitmentsFitIfTheVaultCoversBoth() public {
        _commit(alice, address(usdc), 600e6, EO_1, 1);
        _commit(alice, address(usdc), 400e6, EO_2, 2);
        assertEq(executor.lockedBalance(alice, address(usdc)), 1_000e6);
        assertEq(executor.availableBalance(alice, address(usdc)), 0);
    }

    /// Arming the same order twice must resize the one hold, not stack a second.
    function test_RelockingTheSameIdResizesRatherThanStacks() public {
        _commit(alice, address(usdc), 600e6, EO_1, 1);
        _commit(alice, address(usdc), 900e6, EO_1, 2);
        assertEq(executor.lockedBalance(alice, address(usdc)), 900e6);
        assertEq(executor.getCommitment(EO_1).epoch, 2);
    }

    function test_LockOverTheFreeBalanceReverts() public {
        AgentExecutor.CommitIntent memory intent = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 1_500e6,
            unlockAt: uint64(block.timestamp + 14 days),
            commitmentId: EO_1,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig2 = _signCommit(agentPk, intent);
        vm.expectRevert();
        executor.lockForCommitment(intent, sig2);
    }

    // ── Who may lock ─────────────────────────────────────────────

    function test_LockNeedsTheAgentSignerNamedByTheCapability() public {
        AgentExecutor.CommitIntent memory intent = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 100e6,
            unlockAt: uint64(block.timestamp + 14 days),
            commitmentId: EO_1,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig3 = _signCommit(0xBAD, intent);
        vm.expectRevert();
        executor.lockForCommitment(intent, sig3);
    }

    function test_LockNeedsALiveCapability() public {
        vm.prank(alice);
        executor.revokeCapability();
        AgentExecutor.CommitIntent memory intent = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 100e6,
            unlockAt: uint64(block.timestamp + 14 days),
            commitmentId: EO_1,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig4 = _signCommit(agentPk, intent);
        vm.expectRevert(AgentExecutor.CapabilityRevokedError.selector);
        executor.lockForCommitment(intent, sig4);
    }

    function test_LockNonceCannotBeReplayed() public {
        AgentExecutor.CommitIntent memory intent = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 100e6,
            unlockAt: uint64(block.timestamp + 14 days),
            commitmentId: EO_1,
            nonce: 7,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _signCommit(agentPk, intent);
        executor.lockForCommitment(intent, sig);
        vm.expectRevert(abi.encodeWithSelector(AgentExecutor.NonceUsed.selector, uint256(7)));
        executor.lockForCommitment(intent, sig);
    }

    function test_LockWindowMustBeAheadAndBounded() public {
        AgentExecutor.CommitIntent memory past = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 100e6,
            unlockAt: uint64(block.timestamp),
            commitmentId: EO_1,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig5 = _signCommit(agentPk, past);
        vm.expectRevert();
        executor.lockForCommitment(past, sig5);

        AgentExecutor.CommitIntent memory forever = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 100e6,
            unlockAt: uint64(block.timestamp + 365 days),
            commitmentId: EO_1,
            nonce: 2,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig6 = _signCommit(agentPk, forever);
        vm.expectRevert();
        executor.lockForCommitment(forever, sig6);
    }

    // ── Giving it back ───────────────────────────────────────────

    function test_ReleaseFreesTheMoney() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        _uncommit(alice, EO_1);
        assertEq(executor.lockedBalance(alice, address(usdc)), 0);
        vm.prank(alice);
        executor.withdraw(address(usdc), 1_000e6);
        assertEq(usdc.balanceOf(alice), 1_000e6);
    }

    /// A cleanup sweep runs on every exit path and some of those overlap, so
    /// releasing twice has to be dull rather than fatal.
    function test_ReleasingTwiceIsANoOp() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        AgentExecutor.ReleaseIntent memory intent = AgentExecutor.ReleaseIntent({
            user: alice, commitmentId: EO_1, epoch: 1, deadline: block.timestamp + 1 hours
        });
        bytes memory sig = _signRelease(agentPk, intent);
        executor.releaseCommitment(intent, sig);
        executor.releaseCommitment(intent, sig); // dull on purpose
        assertEq(executor.lockedBalance(alice, address(usdc)), 0);
    }

    /// An old release signature must not be able to undo a later lock of the
    /// same order, which is what the epoch is for.
    function test_StaleReleaseCannotUndoALaterLock() public {
        _commit(alice, address(usdc), 400e6, EO_1, 1);
        AgentExecutor.ReleaseIntent memory stale = AgentExecutor.ReleaseIntent({
            user: alice, commitmentId: EO_1, epoch: 1, deadline: block.timestamp + 365 days
        });
        bytes memory sig = _signRelease(agentPk, stale);
        executor.releaseCommitment(stale, sig);

        _commit(alice, address(usdc), 900e6, EO_1, 2); // armed again, epoch 2
        vm.expectRevert(abi.encodeWithSelector(AgentExecutor.CommitmentMismatch.selector, EO_1));
        executor.releaseCommitment(stale, sig);
        assertEq(executor.lockedBalance(alice, address(usdc)), 900e6, "the new hold stands");
    }

    function test_ReleaseNeedsTheAgentSigner() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        AgentExecutor.ReleaseIntent memory intent = AgentExecutor.ReleaseIntent({
            user: alice, commitmentId: EO_1, epoch: 1, deadline: block.timestamp + 1 hours
        });
        bytes memory sig7 = _signRelease(0xBAD, intent);
        vm.expectRevert();
        executor.releaseCommitment(intent, sig7);
    }

    // ── The two exits that need nobody's cooperation ─────────────

    function test_ExpiredCommitmentIsReleasableByAnyone() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        vm.expectRevert();
        executor.releaseExpiredCommitment(EO_1);

        vm.warp(block.timestamp + 15 days);
        vm.prank(makeAddr("a passerby"));
        executor.releaseExpiredCommitment(EO_1);
        assertEq(executor.lockedBalance(alice, address(usdc)), 0);
    }

    function test_OwnerTakesItBackByRevoking() public {
        _commit(alice, address(usdc), 1_000e6, EO_1, 1);

        // Not while the agent could still honour it.
        vm.prank(alice);
        vm.expectRevert(AgentExecutor.CapabilityStillLive.selector);
        executor.releaseOwnCommitment(EO_1);

        vm.startPrank(alice);
        executor.revokeCapability();
        executor.releaseOwnCommitment(EO_1);
        executor.withdraw(address(usdc), 1_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 1_000e6, "money is never trapped");
    }

    function test_OnlyTheOwnerTakesTheirOwnBack() public {
        _commit(alice, address(usdc), 800e6, EO_1, 1);
        vm.prank(alice);
        executor.revokeCapability();
        vm.prank(makeAddr("somebody else"));
        vm.expectRevert(AgentExecutor.NotCommitmentOwner.selector);
        executor.releaseOwnCommitment(EO_1);
    }

    // ── Commitments belong to exactly one user and one token ─────

    function test_CannotSpendSomebodyElsesCommitment() public {
        _commit(alice, address(usdc), 500e6, EO_1, 1);
        address bob = makeAddr("bob");
        _fundVault(bob, 1_000e6);
        _grantLarge(bob);
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) = _swap(bob, 500e6, EO_1, 1);
        vm.expectRevert(abi.encodeWithSelector(AgentExecutor.CommitmentMismatch.selector, EO_1));
        executor.executeSwap(intent, sig);
    }

    function test_CannotSpendACommitmentThatWasNeverMade() public {
        (AgentExecutor.SwapIntent memory intent, bytes memory sig) = _swap(alice, 100e6, EO_2, 1);
        vm.expectRevert(abi.encodeWithSelector(AgentExecutor.CommitmentNotActive.selector, EO_2));
        executor.executeSwap(intent, sig);
    }

    function test_CannotSpendACommitmentOnTheWrongToken() public {
        _commit(alice, address(usdc), 500e6, EO_1, 1);
        weth.mint(alice, 1e18);
        vm.startPrank(alice);
        weth.approve(address(executor), 1e18);
        executor.deposit(address(weth), 1e18);
        vm.stopPrank();

        uint256 quote = router.quoteSwap(address(weth), address(usdc), 1e17);
        AgentExecutor.SwapIntent memory intent = AgentExecutor.SwapIntent({
            user: alice,
            tokenIn: address(weth),
            tokenOut: address(usdc),
            amountIn: 1e17,
            minAmountOut: (quote * 9_950) / 10_000,
            commitmentId: EO_1,
            nonce: 2,
            deadline: block.timestamp + 1 hours
        });
        bytes memory sig8 = _signSwap(agentPk, intent);
        vm.expectRevert(abi.encodeWithSelector(AgentExecutor.CommitmentMismatch.selector, EO_1));
        executor.executeSwap(intent, sig8);
    }

    // ── Batches: a playbook arms every rung or none ──────────────

    function test_BatchLockIsAllOrNothing() public {
        AgentExecutor.CommitIntent[] memory intents = new AgentExecutor.CommitIntent[](2);
        bytes[] memory sigs = new bytes[](2);
        intents[0] = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 700e6,
            unlockAt: uint64(block.timestamp + 14 days),
            commitmentId: EO_1,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        intents[1] = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 700e6, // only 300 left by now
            unlockAt: uint64(block.timestamp + 14 days),
            commitmentId: EO_2,
            nonce: 2,
            deadline: block.timestamp + 1 hours
        });
        sigs[0] = _signCommit(agentPk, intents[0]);
        sigs[1] = _signCommit(agentPk, intents[1]);

        vm.expectRevert();
        executor.lockForCommitments(intents, sigs);
        assertEq(executor.lockedBalance(alice, address(usdc)), 0, "no half-funded plan");

        intents[1].amount = 300e6;
        sigs[1] = _signCommit(agentPk, intents[1]);
        executor.lockForCommitments(intents, sigs);
        assertEq(executor.lockedBalance(alice, address(usdc)), 1_000e6);
    }

    function test_BatchLengthsMustMatch() public {
        AgentExecutor.CommitIntent[] memory intents = new AgentExecutor.CommitIntent[](1);
        bytes[] memory sigs = new bytes[](2);
        intents[0] = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: 1e6,
            unlockAt: uint64(block.timestamp + 1 days),
            commitmentId: EO_1,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        vm.expectRevert(AgentExecutor.LengthMismatch.selector);
        executor.lockForCommitments(intents, sigs);
    }

    // ── The invariant the whole thing rests on ───────────────────

    /// Locked can never exceed the balance it sits inside. If it ever could,
    /// `availableBalance` would floor at zero and quietly hide a vault that owes
    /// more than it holds, which is exactly the state this redesign removes.
    function testFuzz_LockedNeverExceedsTheBalance(uint96 lock, uint96 take, uint96 trade) public {
        uint256 want = uint256(lock) % 1_001e6;
        if (want == 0) want = 1;
        AgentExecutor.CommitIntent memory intent = AgentExecutor.CommitIntent({
            user: alice,
            token: address(usdc),
            amount: want,
            unlockAt: uint64(block.timestamp + 10 days),
            commitmentId: EO_1,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        try executor.lockForCommitment(intent, _signCommit(agentPk, intent)) {} catch {}

        vm.prank(alice);
        try executor.withdraw(address(usdc), uint256(take) % 1_001e6) {} catch {}

        (AgentExecutor.SwapIntent memory swapIntent, bytes memory sig) =
            _swap(alice, (uint256(trade) % 1_000e6) + 1, bytes32(0), 2);
        try executor.executeSwap(swapIntent, sig) {} catch {}

        assertLe(
            executor.lockedBalance(alice, address(usdc)),
            executor.vaultBalance(alice, address(usdc)),
            "a hold outlived the money behind it"
        );
    }
}
