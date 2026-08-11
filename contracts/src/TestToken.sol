// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestToken
/// @notice A faucet backed ERC20 for the Roque testnet. Anyone can top up their
/// balance once every cooldown window, which is exactly what you want when a
/// judge or a teammate lands on the app with an empty wallet and wants to try a
/// swap without begging in a Discord channel.
/// @dev Decimals are configurable at deploy time so we can mirror real assets:
/// six for a dollar stablecoin, eighteen for wrapped ether.
contract TestToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    /// @notice How much a single faucet pull hands out, in token units.
    uint256 public immutable faucetAmount;

    /// @notice Minimum gap between two faucet pulls from the same address.
    uint256 public constant FAUCET_COOLDOWN = 8 hours;

    /// @notice Last time an address pulled from the faucet.
    mapping(address => uint256) public lastFaucet;

    event FaucetPulled(address indexed to, uint256 amount);

    error FaucetOnCooldown(uint256 readyAt);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 faucetAmount_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        _decimals = decimals_;
        faucetAmount = faucetAmount_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Pull the standard faucet amount to your own wallet.
    function faucet() external {
        _faucetTo(msg.sender);
    }

    /// @notice Pull the faucet amount to someone else, handy for seeding a demo.
    function faucetTo(address to) external {
        _faucetTo(to);
    }

    function _faucetTo(address to) internal {
        uint256 ready = lastFaucet[to] + FAUCET_COOLDOWN;
        // First pull ever (lastFaucet == 0) always sails through.
        if (lastFaucet[to] != 0 && block.timestamp < ready) {
            revert FaucetOnCooldown(ready);
        }
        lastFaucet[to] = block.timestamp;
        _mint(to, faucetAmount);
        emit FaucetPulled(to, faucetAmount);
    }

    /// @notice Owner mint, used once at deploy time to seed the initial pool.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
