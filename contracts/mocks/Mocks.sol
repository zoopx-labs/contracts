// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../BoostVault.sol"; // Corrected import path

/**
 * @title ERC20PermitMock
 * @dev A mock ERC20 token that includes the EIP-2612 permit functionality
 * and a public mint function for testing purposes.
 */
contract ERC20PermitMock is ERC20, ERC20Permit {
    constructor(
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) ERC20Permit(name) {}

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}

/**
 * @title ReentrancyAttacker
 * @dev A mock contract designed to attempt reentrancy attacks on the BoostVault.
 */
contract ReentrancyAttacker {
    BoostVault public immutable vault;
    IERC20 public immutable zTICSContract;

    // State to control which function to re-enter
    enum AttackMode {
        NONE,
        STAKE,
        UNSTAKE,
        CLAIM
    }
    AttackMode public attackMode;

    constructor(address _vaultAddress, address _zTICSAddress) {
        vault = BoostVault(_vaultAddress);
        zTICSContract = IERC20(_zTICSAddress);
    }

    // --- Setup Functions ---

    // A normal stake function to set up the scenario before an attack
    function stakeForMe(uint256 _amount) external {
        zTICSContract.approve(address(vault), _amount);
        vault.stakeZtics(_amount);
    }

    // --- Attack Functions ---

    function attackStake(uint256 _amount) external {
        attackMode = AttackMode.STAKE;
        zTICSContract.approve(address(vault), _amount);
        vault.stakeZtics(_amount);
        attackMode = AttackMode.NONE; // Reset after call
    }

    function attackUnstake(uint256 _amount) external {
        attackMode = AttackMode.UNSTAKE;
        vault.unstakeZtics(_amount);
        attackMode = AttackMode.NONE; // Reset after call
    }

    function attackClaim() external {
        attackMode = AttackMode.CLAIM;
        vault.claimPoints();
        attackMode = AttackMode.NONE; // Reset after call
    }

    // --- Fallback/Receive for Reentrancy ---

    // The receive function is called when zTICS is transferred via safeTransfer.
    // The BoostVault's unstakeZtics function triggers this.
    receive() external payable {
        if (attackMode == AttackMode.UNSTAKE) {
            // Attempt to re-enter unstakeZtics while in the middle of the first unstake
            vault.unstakeZtics(1); // Attack with a small amount
        }
    }

    // The fallback is called when a function is called on this contract.
    // The BoostVault's stakeZtics and claimPoints do not make external calls
    // back to the user, so this fallback is primarily for re-entering during unstake.
    fallback() external payable {
        if (attackMode == AttackMode.STAKE) {
            vault.stakeZtics(1);
        } else if (attackMode == AttackMode.CLAIM) {
            vault.claimPoints();
        }
    }
}
