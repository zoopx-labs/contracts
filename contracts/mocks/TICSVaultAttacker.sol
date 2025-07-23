// contracts/mocks/ReentrancyAttacker.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol"; // Still needed for zTICS
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol"; // Still needed for zTICS
import "../../contracts/TICS_Staking_Vault.sol"; // Adjust path if TICS_Staking_Vault is in a different directory

/**
 * @title ReentrancyAttacker
 * @dev A mock contract designed to attempt reentrancy attacks on the TICS_Staking_Vault.
 * It holds ERC20 tokens (TICS and zTICS) and can call vault functions, attempting to re-enter
 * during external calls.
 */
contract ReentrancyAttacker {
    using SafeERC20 for IERC20; // Re-added this directive, though direct calls are now used

    TICS_Staking_Vault public immutable vault;
    // Removed: IERC20 public immutable ticsToken; // TICS is now native
    IERC20 public immutable zTICSContract; // Using IERC20 for zTICS as well for simplicity

    // State to control reentrancy attempts
    uint256 public attackState; // 0: idle, 1: re-entering deposit, 2: re-entering instantWithdraw, etc.
    uint256 public attackAmount; // For TICS (native) or zTICS (ERC20)
    uint256 public attackTokenId;

    // MODIFIED: Removed _ticsToken from constructor
    constructor(address _vault, address _zTICS) {
        vault = TICS_Staking_Vault(_vault);
        zTICSContract = IERC20(_zTICS);
    }

    // --- Attack Functions ---

    // Attempts to re-enter deposit() with native TICS
    function attackDeposit(uint256 _minZticsToMint) external payable {
        attackState = 1; // Set state to indicate re-entering deposit
        attackAmount = msg.value; // Get amount from msg.value
        vault.deposit{value: msg.value}(_minZticsToMint); // Send msg.value
    }

    // Attempts to re-enter instantWithdraw()
    function attackInstantWithdraw(
        uint256 _zTicsAmount,
        uint256 _minExpectedTics
    ) external {
        attackState = 2; // Set state to indicate re-entering instantWithdraw
        attackAmount = _zTicsAmount;
        // Approve vault to spend attacker's zTICS
        // MODIFIED: Changed SafeERC20.safeApprove to SafeERC20.forceApprove
        SafeERC20.forceApprove(zTICSContract, address(vault), _zTicsAmount);
        vault.instantWithdraw(_zTicsAmount, _minExpectedTics);
    }

    // Attempts to re-enter withdraw()
    function attackWithdraw(uint256 _zTicsAmount) external {
        attackState = 3; // Set state to indicate re-entering withdraw
        attackAmount = _zTicsAmount;
        // Approve vault to spend attacker's zTICS
        // MODIFIED: Changed SafeERC20.safeApprove to SafeERC20.forceApprove
        SafeERC20.forceApprove(zTICSContract, address(vault), _zTicsAmount);
        vault.withdraw(_zTicsAmount);
    }

    // Attempts to re-enter claimPrincipal()
    function attackClaimPrincipal(uint256 _tokenId) external {
        attackState = 4; // Set state to indicate re-entering claimPrincipal
        attackTokenId = _tokenId;
        vault.claimPrincipal(_tokenId);
    }

    // Attempts to re-enter claimVestedRewards()
    function attackClaimVestedRewards(uint256 _tokenId) external {
        attackState = 5; // Set state to indicate re-entering claimVestedRewards
        attackTokenId = _tokenId;
        vault.claimVestedRewards(_tokenId);
    }

    // Attempts to re-enter claimLockedRewards()
    function attackClaimLockedRewards() external {
        attackState = 6; // Set state to indicate re-entering claimLockedRewards
        vault.claimLockedRewards();
    }

    // Attempts to re-enter stakeZtics()
    function attackStakeZtics(uint256 _amount) external {
        attackState = 7; // Set state to indicate re-entering stakeZtics
        attackAmount = _amount;
        // MODIFIED: Changed SafeERC20.safeApprove to SafeERC20.forceApprove
        SafeERC20.forceApprove(zTICSContract, address(vault), _amount);
        vault.stakeZtics(_amount);
    }

    // Attempts to re-enter unstakeZtics()
    function attackUnstakeZtics(uint256 _amount) external {
        attackState = 8; // Set state to indicate re-entering unstakeZtics
        attackAmount = _amount;
        vault.unstakeZtics(_amount);
    }

    // Attempts to re-enter oneClickStakeAndBoost() with native TICS
    function attackOneClickStakeAndBoost(
        uint256 _minZticsToMint
    ) external payable {
        attackState = 9; // Set state to indicate re-entering oneClickStakeAndBoost
        attackAmount = msg.value; // Get amount from msg.value
        vault.oneClickStakeAndBoost{value: msg.value}(_minZticsToMint); // Send msg.value
    }

    // --- Internal Helper for Reentrancy Logic ---
    function _handleReentrancyAttack() internal {
        if (attackState == 1) {
            // Re-entering deposit
            vault.deposit{value: attackAmount}(0);
        } else if (attackState == 2) {
            // Re-entering instantWithdraw
            vault.instantWithdraw(attackAmount, 0); // MODIFIED: Removed {value: 0}
        } else if (attackState == 3) {
            // Re-entering withdraw
            vault.withdraw(attackAmount); // MODIFIED: Removed {value: 0}
        } else if (attackState == 4) {
            // Re-entering claimPrincipal
            vault.claimPrincipal(attackTokenId); // MODIFIED: Removed {value: 0}
        } else if (attackState == 5) {
            // Re-entering claimVestedRewards
            vault.claimVestedRewards(attackTokenId); // MODIFIED: Removed {value: 0}
        } else if (attackState == 6) {
            // Re-entering claimLockedRewards
            vault.claimLockedRewards(); // MODIFIED: Removed {value: 0}
        } else if (attackState == 7) {
            // Re-entering stakeZtics
            vault.stakeZtics(attackAmount); // MODIFIED: Removed {value: 0}
        } else if (attackState == 8) {
            // Re-entering unstakeZtics
            vault.unstakeZtics(attackAmount); // MODIFIED: Removed {value: 0}
        } else if (attackState == 9) {
            // Re-entering oneClickStakeAndBoost
            vault.oneClickStakeAndBoost{value: attackAmount}(0);
        }
    }

    // --- Fallback/Receive for Reentrancy ---

    // The receive function is called when Ether is sent to the contract without data.
    receive() external payable {
        _handleReentrancyAttack(); // Call the internal helper
    }

    // The fallback function is called when Ether is sent with data or a non-existent function is called.
    fallback() external payable {
        _handleReentrancyAttack(); // Call the internal helper
    }

    // Helper to withdraw any recovered zTICS (ERC20)
    function withdrawERC20(address _token, address _to) external {
        SafeERC20.safeTransfer(
            IERC20(_token),
            _to,
            IERC20(_token).balanceOf(address(this))
        );
    }

    // Helper to withdraw any native TICS (ETH/QUBE)
    function withdrawNativeToken(address payable _to) external {
        _to.transfer(address(this).balance);
    }
}
