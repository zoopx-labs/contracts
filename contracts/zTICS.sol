// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title ZoopX Staked TICS (zTICS)
 * @author ZoopX Labs
 * @notice This is the liquid staking token for the ZoopX Protocol on the Qubetics network.
 * It is a yield-bearing ERC-20 token that represents a user's share of the TICS staking pool.
 * It includes EIP-2612 permit support for gasless approvals.
 * The contract is owned by the TICS_Staking_Vault, which is the only address with the
 * authority to mint (on deposit) or burn (on withdrawal) zTICS tokens.
 */
contract zTICS is ERC20, Ownable, ERC20Permit {
    /**
     * @notice Constructor to initialize the ERC-20 token and ERC20Permit.
     * @param _vaultAddress The address of the TICS_Staking_Vault contract that will own this token contract.
     */
    constructor(address _vaultAddress)
        ERC20("ZoopX Staked TICS", "zTICS")
        ERC20Permit("ZoopX Staked TICS")
        Ownable(_vaultAddress)
    {
        // The initial owner is set to the vault address passed during deployment.
        // This ensures only the staking vault can control the token supply.
    }

    /**
     * @notice Creates new zTICS tokens.
     * @dev This function can only be called by the owner of this contract, which is the TICS_Staking_Vault.
     * This is the mechanism for issuing zTICS to users when they deposit TICS.
     * @param to The address to mint the new tokens to.
     * @param amount The amount of zTICS tokens to mint.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Destroys a specified amount of zTICS tokens from a user's balance.
     * @dev This function can only be called by the owner of this contract, which is the TICS_Staking_Vault.
     * This is the mechanism for burning zTICS when a user withdraws their TICS from the protocol.
     * @param from The address from which to burn the tokens.
     * @param amount The amount of zTICS tokens to burn.
     */
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
