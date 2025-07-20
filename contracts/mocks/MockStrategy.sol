// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockStrategy
 * @author ZoopX Labs
 * @notice This is a simple mock contract used for testing the Admin contract.
 * It simulates the basic functionality of the real Strategy.sol contract,
 * allowing us to test the interaction between Admin.sol and Strategy.sol.
 */
contract MockStrategy {
    address[] public validators;
    mapping(address => bool) public isValidator;

    function addValidator(address _validator) external {
        if (!isValidator[_validator]) {
            validators.push(_validator);
            isValidator[_validator] = true;
        }
    }

    function removeValidator(address _validator) external {
        // This is a simple removal logic for testing purposes.
        // It is not gas-efficient and should not be used in production.
        if (isValidator[_validator]) {
            for (uint i = 0; i < validators.length; i++) {
                if (validators[i] == _validator) {
                    validators[i] = validators[validators.length - 1];
                    validators.pop();
                    isValidator[_validator] = false;
                    break;
                }
            }
        }
    }
}
