// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Base} from "./Base.t.sol";
import {AgentExecutor} from "../src/AgentExecutor.sol";

contract SecurityTest is Base {
    function _pendingGrant(uint256 pk, address user, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 h = keccak256(
            abi.encode(
                GRANT_TYPEHASH,
                user,
                agentSigner,
                uint256(500e18),
                uint256(2000e18),
                uint256(100),
                uint64(block.timestamp + 1 days),
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(h));
        return abi.encodePacked(r, s, v);
    }

    function test_RevokeInvalidatesUnconsumedGrant() public {
        uint256 pk = 0x1234;
        address user = vm.addr(pk);
        _grantStandard(user);
        bytes memory sig = _pendingGrant(pk, user, executor.grantNonce(user));
        vm.prank(user);
        executor.revokeCapability();
        vm.expectRevert();
        executor.grantCapabilityWithSig(
            user, agentSigner, 500e18, 2000e18, 100, uint64(block.timestamp + 1 days), sig
        );
    }

    function test_DirectGrantInvalidatesUnconsumedGrant() public {
        uint256 pk = 0x1234;
        address user = vm.addr(pk);
        bytes memory sig = _pendingGrant(pk, user, executor.grantNonce(user));
        _grantStandard(user);
        vm.expectRevert();
        executor.grantCapabilityWithSig(
            user, agentSigner, 500e18, 2000e18, 100, uint64(block.timestamp + 1 days), sig
        );
    }

    function test_RegrantInvalidatesOldSpend() public {
        _fundVault(alice, 100e6);
        _grantStandard(alice);
        AgentExecutor.SwapIntent memory i = AgentExecutor.SwapIntent(
            alice,
            address(usdc),
            address(weth),
            50e6,
            router.quoteSwap(address(usdc), address(weth), 50e6) * 9950 / 10000,
            bytes32(0),
            44,
            block.timestamp + 1 hours
        );
        bytes memory sig = _signSwap(agentPk, i);
        vm.prank(alice);
        executor.revokeCapability();
        _grantStandard(alice);
        vm.expectRevert();
        executor.executeSwap(i, sig);
    }

    function test_StaleLowFeedCannotUndervalueCap() public {
        vm.warp(100000);
        feed.setAnswerAndTime(1e8, 1);
        vm.expectRevert();
        executor.usdValue(address(weth), 1e18);
    }

    function test_FutureFeedRejected() public {
        feed.setAnswerAndTime(ETH_USD, block.timestamp + 1);
        vm.expectRevert();
        executor.usdValue(address(weth), 1e18);
    }

    function test_LimitCannotUseZeroFloor() public {
        _fundVault(alice, 100e6);
        _grantStandard(alice);
        AgentExecutor.LimitIntent memory i = AgentExecutor.LimitIntent(
            alice,
            address(usdc),
            address(weth),
            50e6,
            0,
            2000e8,
            false,
            uint64(block.timestamp + 1 days),
            bytes32(0),
            99,
            block.timestamp + 1 hours
        );
        bytes memory sig = _signLimit(agentPk, i);
        vm.expectRevert();
        executor.createLimitOrder(i, sig);
    }
}
