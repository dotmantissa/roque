// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {OrderBook} from "../src/OrderBook.sol";

contract OrderBookTest is Base {
    uint64 internal expiry;

    function setUp() public override {
        super.setUp();
        expiry = uint64(block.timestamp + 2 days);
    }

    /// @dev Alice wants to buy WETH with 2500 USDC when ETH drops to 2400.
    function _openBuyDipOrder() internal returns (uint256 id) {
        usdc.mint(alice, 2_500e6);
        vm.startPrank(alice);
        usdc.approve(address(orderBook), 2_500e6);
        id = orderBook.createOrder(address(usdc), address(weth), 2_500e6, 0, 2_400e8, false, expiry);
        vm.stopPrank();
    }

    function test_CreateEscrowsInput() public {
        uint256 id = _openBuyDipOrder();
        assertEq(usdc.balanceOf(address(orderBook)), 2_500e6);
        OrderBook.Order memory o = orderBook.getOrder(id);
        assertEq(o.owner, alice);
        assertEq(uint256(o.status), uint256(OrderBook.Status.Open));
    }

    function test_NotTriggeredAtCurrentPrice() public {
        uint256 id = _openBuyDipOrder();
        // Price is 2500, trigger is buy-below-2400, so it must not be fillable.
        assertFalse(orderBook.isTriggered(id));
        vm.expectRevert();
        orderBook.executeOrder(id);
    }

    function test_FillsOncePriceDropsThroughTrigger() public {
        uint256 id = _openBuyDipOrder();
        feed.setAnswer(2_390e8); // ETH dips below the trigger

        assertTrue(orderBook.isTriggered(id));
        uint256 out = orderBook.executeOrder(id);

        assertGt(out, 0);
        assertEq(weth.balanceOf(alice), out); // output goes to the owner
        OrderBook.Order memory o = orderBook.getOrder(id);
        assertEq(uint256(o.status), uint256(OrderBook.Status.Filled));
    }

    function test_KeeperCannotForceUntriggeredFill() public {
        uint256 id = _openBuyDipOrder();
        address keeper = makeAddr("keeper");
        vm.prank(keeper);
        vm.expectRevert();
        orderBook.executeOrder(id);
    }

    function test_SellAboveTrigger() public {
        // Sell 1 WETH for USDC when ETH climbs to 2600.
        weth.mint(alice, 1e18);
        vm.startPrank(alice);
        weth.approve(address(orderBook), 1e18);
        uint256 id =
            orderBook.createOrder(address(weth), address(usdc), 1e18, 0, 2_600e8, true, expiry);
        vm.stopPrank();

        assertFalse(orderBook.isTriggered(id));
        feed.setAnswer(2_650e8);
        assertTrue(orderBook.isTriggered(id));

        uint256 out = orderBook.executeOrder(id);
        assertEq(usdc.balanceOf(alice), out);
    }

    function test_CancelReturnsEscrow() public {
        uint256 id = _openBuyDipOrder();
        vm.prank(alice);
        orderBook.cancelOrder(id);
        assertEq(usdc.balanceOf(alice), 2_500e6);
        OrderBook.Order memory o = orderBook.getOrder(id);
        assertEq(uint256(o.status), uint256(OrderBook.Status.Cancelled));
    }

    function test_OnlyOwnerCancels() public {
        uint256 id = _openBuyDipOrder();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(OrderBook.NotOwnerOfOrder.selector);
        orderBook.cancelOrder(id);
    }

    function test_ExpiredOrderCannotFill() public {
        uint256 id = _openBuyDipOrder();
        feed.setAnswer(2_390e8);
        vm.warp(expiry + 1);
        vm.expectRevert(OrderBook.OrderExpired.selector);
        orderBook.executeOrder(id);
    }

    function test_StalePriceReverts() public {
        uint256 id = _openBuyDipOrder();
        // Push the feed answer far into the past relative to now.
        vm.warp(block.timestamp + 48 hours);
        feed.setAnswerAndTime(2_390e8, block.timestamp - 48 hours);
        vm.expectRevert(OrderBook.StalePrice.selector);
        orderBook.executeOrder(id);
    }

    function test_CannotFillTwice() public {
        uint256 id = _openBuyDipOrder();
        feed.setAnswer(2_390e8);
        orderBook.executeOrder(id);
        vm.expectRevert(OrderBook.OrderNotOpen.selector);
        orderBook.executeOrder(id);
    }

    function test_OnlyAgentExecutorCreatesForUser() public {
        vm.prank(makeAddr("notexecutor"));
        vm.expectRevert(OrderBook.NotAgentExecutor.selector);
        orderBook.createOrderFor(
            alice, address(usdc), address(weth), 1e6, 0, 2_400e8, false, expiry
        );
    }
}
