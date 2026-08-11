// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestToken} from "./TestToken.sol";

/// @title FaucetRouter
/// @notice A thin convenience over the per token faucets so a user can top up
/// every asset on the app with a single signature instead of ten. It holds
/// nothing and has no privileges; it simply calls `faucetTo(msg.sender)` on each
/// token in turn. Because the per token cap is tracked against the receiver, not
/// the caller, going through this router is exactly equivalent to pulling each
/// faucet yourself, cap and all.
/// @dev Each pull is wrapped so one exhausted token, or any single failure, is
/// skipped rather than reverting the whole batch. The user gets whatever they
/// were still owed and the maxed out tokens are quietly passed over.
contract FaucetRouter {
    event ClaimedAll(address indexed user, uint256 succeeded, uint256 skipped);

    /// @notice Pull the faucet on each token in the list to the caller. Tokens
    /// the caller has already exhausted, or that revert for any reason, are
    /// skipped. Returns how many actually paid out.
    /// @param tokens The token addresses to claim from.
    function claimAll(address[] calldata tokens) external returns (uint256 succeeded) {
        uint256 skipped;
        for (uint256 i = 0; i < tokens.length; i++) {
            // try/catch so a single exhausted or misbehaving token cannot strand
            // the rest of the batch. faucetTo credits msg.sender, the real user.
            try TestToken(tokens[i]).faucetTo(msg.sender) {
                succeeded++;
            } catch {
                skipped++;
            }
        }
        emit ClaimedAll(msg.sender, succeeded, skipped);
    }

    /// @notice How many of the listed tokens the user can still claim right now,
    /// so the UI can enable or disable a single claim-all button sensibly.
    function claimableCount(address user, address[] calldata tokens)
        external
        view
        returns (uint256 count)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (TestToken(tokens[i]).claimsRemaining(user) > 0) count++;
        }
    }
}
