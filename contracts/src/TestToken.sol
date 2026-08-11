// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestToken
/// @notice A faucet backed ERC20 for the Roque testnet. Every token the app
/// trades is one of these: a plain ERC20 with a metered faucet bolted on, so a
/// judge or a teammate who lands on the app with an empty wallet can fund
/// themselves and try a swap without begging in a Discord channel.
/// @dev Decimals are configurable at deploy time so we can mirror real assets:
/// six for a dollar stablecoin, eight for wrapped bitcoin, eighteen for the rest.
/// The faucet hands out a fixed amount worth about a thousand dollars, set once
/// at deploy from the token's Chainlink price, and it caps each address at a
/// small number of pulls so the pools cannot be farmed dry.
contract TestToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    /// @notice How much a single faucet pull hands out, in token units. Chosen at
    /// deploy so it is worth roughly one thousand dollars at the launch price.
    uint256 public immutable faucetAmount;

    /// @notice The most times any one address may ever pull this faucet.
    uint256 public constant MAX_CLAIMS = 5;

    /// @notice How many times an address has already pulled.
    mapping(address => uint256) public claimCount;

    event FaucetPulled(address indexed to, uint256 amount, uint256 claimNumber);

    error FaucetExhausted(address who);

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

    /// @notice Pull the faucet amount to someone else. Handy for the claim-all
    /// helper, which calls this once per token on the caller's behalf, and for
    /// seeding a demo wallet. The cap is tracked against `to`, the receiver, so
    /// routing a pull through a helper cannot sidestep it.
    function faucetTo(address to) external {
        _faucetTo(to);
    }

    /// @notice How many pulls this address has left, for the UI to show and the
    /// claim-all helper to check before it bothers spending gas.
    function claimsRemaining(address who) external view returns (uint256) {
        uint256 used = claimCount[who];
        return used >= MAX_CLAIMS ? 0 : MAX_CLAIMS - used;
    }

    function _faucetTo(address to) internal {
        uint256 used = claimCount[to];
        if (used >= MAX_CLAIMS) revert FaucetExhausted(to);
        claimCount[to] = used + 1;
        _mint(to, faucetAmount);
        emit FaucetPulled(to, faucetAmount, used + 1);
    }

    /// @notice Owner mint, used at deploy time to seed the pools and hold a
    /// faucet reserve. Not reachable by users.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
