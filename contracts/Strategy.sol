// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ZoopX Validator Strategy
 * @author ZoopX Labs
 * @notice This contract maintains a whitelist of approved validator addresses for the ZoopX staking protocol.
 * It is owned and managed exclusively by the Admin.sol contract. Its primary purpose is to provide
 * a secure and verifiable on-chain registry that the TICS_Staking_Vault can query to determine
 * where it is permitted to delegate funds.
 */
contract Strategy is Ownable {
    // --- State Variables ---

    // A mapping for efficient, O(1) checking of whether an address is a whitelisted validator.
    mapping(address => bool) public isValidator;

    // A private mapping to store the index of each validator for gas-efficient removal.
    mapping(address => uint256) private validatorIndex;

    // An array to store the list of all whitelisted validators for easy enumeration.
    // Made private to enforce access through the getter function.
    address[] private validators;

    // --- Events ---
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);

    /**
     * @notice Constructor to set the initial owner of the contract.
     * @param _adminAddress The address of the Admin.sol contract that will own this Strategy contract.
     */
    constructor(address _adminAddress) Ownable(_adminAddress) {
        require(
            _adminAddress != address(0),
            "Strategy: Admin address cannot be zero"
        );
    }

    // --- External Functions (Owner-Only) ---

    /**
     * @notice Adds a new validator to the whitelist.
     * @dev Can only be called by the owner (the Admin.sol contract).
     * Reverts if the address is the zero address or is already on the list.
     * @param _validator The EVM address of the validator to add.
     */
    function addValidator(address _validator) external onlyOwner {
        require(
            _validator != address(0),
            "Strategy: Validator address cannot be zero"
        );
        require(!isValidator[_validator], "Strategy: Validator already exists");

        isValidator[_validator] = true;
        validatorIndex[_validator] = validators.length;
        validators.push(_validator);

        emit ValidatorAdded(_validator);
    }

    /**
     * @notice Removes a validator from the whitelist in a gas-efficient way.
     * @dev Can only be called by the owner (the Admin.sol contract).
     * Uses the "swap and pop" method for O(1) removal complexity.
     * @param _validator The EVM address of the validator to remove.
     */
    function removeValidator(address _validator) external onlyOwner {
        require(isValidator[_validator], "Strategy: Validator does not exist");

        isValidator[_validator] = false;

        // "Swap and pop" for gas-efficient removal
        uint256 indexToRemove = validatorIndex[_validator];
        address lastValidator = validators[validators.length - 1];

        // If the validator to remove is not the last one in the array,
        // move the last validator into its slot.
        if (indexToRemove != validators.length - 1) {
            validators[indexToRemove] = lastValidator;
            validatorIndex[lastValidator] = indexToRemove;
        }

        // Remove the last element from the array.
        validators.pop();
        delete validatorIndex[_validator];

        emit ValidatorRemoved(_validator);
    }

    // --- View Functions ---

    /**
     * @notice Returns the complete list of whitelisted validator addresses.
     * @return An array of addresses.
     */
    function getValidators() external view returns (address[] memory) {
        return validators;
    }

    /**
     * @notice Returns the number of whitelisted validators.
     * @return The count of validators.
     */
    function getValidatorCount() external view returns (uint256) {
        return validators.length;
    }
}
