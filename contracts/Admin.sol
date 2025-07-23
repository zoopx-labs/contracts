// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Forward declaration for the Strategy contract interface
interface IStrategy {
    function addValidator(address _validator) external;
    function removeValidator(address _validator) external;
}

/**
 * @title ZoopX Admin Contract
 * @author ZoopX Labs
 * @notice This is the central governance and control contract for the ZoopX Protocol.
 * It manages all administrative functions, protocol parameters, and emergency controls.
 * This contract is designed to be owned by a TimelockController, which in turn is
 * controlled by the ZoopX multi-sig, ensuring decentralized and transparent governance.
 */
contract Admin is AccessControl, Pausable {
    // --- Roles ---
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant VALIDATOR_MANAGER_ROLE =
        keccak256("VALIDATOR_MANAGER_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant AMM_MANAGER_ROLE = keccak256("AMM_MANAGER_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // --- State Variables ---
    address public strategyContract;
    address public treasuryAddress;
    uint256 public bridgeFeeBps; // Bridge fee in basis points (e.g., 5 = 0.05%)
    uint256 public stakingFeeBps; // Staking fee on rewards (e.g., 1000 = 10%)

    // --- AMM State Variables ---
    address public ammFactory;
    address public ammRouter;
    uint256 public ammSwapFeeBps; // AMM swap fee in basis points (e.g., 30 = 0.30%)

    // --- Modular Pausing States ---
    bool public isStakingPaused;
    bool public isBridgePaused;
    bool public isAmmPaused;
    bool public isInstantWithdrawPaused;

    // --- Constants ---
    uint256 public constant MAX_BRIDGE_FEE_BPS = 25; // Max fee is 0.25%
    uint256 public constant MAX_STAKING_FEE_BPS = 1000; // Max staking fee on rewards is 10%
    uint256 public constant MAX_AMM_FEE_BPS = 50; // Max AMM swap fee is 0.5%

    // --- Events ---
    event StrategyContractUpdated(
        address indexed oldStrategy,
        address indexed newStrategy
    );
    event TreasuryAddressUpdated(
        address indexed oldTreasury,
        address indexed newTreasury
    );
    event BridgeFeeUpdated(uint256 newFeeBps);
    event StakingFeeUpdated(uint256 newFeeBps);
    event StakingPaused(bool isPaused);
    event BridgePaused(bool isPaused);
    event AmmPaused(bool isPaused);
    event InstantWithdrawPaused(bool isPaused);
    event AmmParametersUpdated(
        address oldFactory,
        address oldRouter,
        address indexed newFactory,
        address indexed newRouter
    );
    event AmmSwapFeeUpdated(uint256 newFeeBps);
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event AdminRenounced(address indexed admin);
    event ERC20Recovered(
        address indexed token,
        address indexed to,
        uint256 amount
    );

    /**
     * @notice Constructor to set up initial roles and parameters.
     * @param _initialAdmin The address that will hold the DEFAULT_ADMIN_ROLE initially.
     * @param _initialTreasury The initial address for collecting protocol fees.
     */
    constructor(address _initialAdmin, address _initialTreasury) {
        require(
            _initialAdmin != address(0),
            "Admin: Initial admin cannot be zero address"
        );
        require(
            _initialTreasury != address(0),
            "Admin: Initial treasury cannot be zero address"
        );

        _grantRole(DEFAULT_ADMIN_ROLE, _initialAdmin);
        _grantRole(PAUSER_ROLE, _initialAdmin);
        _grantRole(VALIDATOR_MANAGER_ROLE, _initialAdmin);
        _grantRole(FEE_MANAGER_ROLE, _initialAdmin);
        _grantRole(AMM_MANAGER_ROLE, _initialAdmin);

        treasuryAddress = _initialTreasury;
        bridgeFeeBps = 5; // Set initial bridge fee to 0.05%
        stakingFeeBps = 1000; // Set initial staking fee to 10% of rewards
        ammSwapFeeBps = 30; // Set initial AMM swap fee to 0.30%
    }

    // --- Pausing Functions ---

    function setStakingPaused(bool _paused) external onlyRole(PAUSER_ROLE) {
        require(isStakingPaused != _paused, "Admin: Already in that state");
        isStakingPaused = _paused;
        emit StakingPaused(_paused);
    }

    function setBridgePaused(bool _paused) external onlyRole(PAUSER_ROLE) {
        require(isBridgePaused != _paused, "Admin: Already in that state");
        isBridgePaused = _paused;
        emit BridgePaused(_paused);
    }

    function setAmmPaused(bool _paused) external onlyRole(PAUSER_ROLE) {
        require(isAmmPaused != _paused, "Admin: Already in that state");
        isAmmPaused = _paused;
        emit AmmPaused(_paused);
    }

    function setInstantWithdrawPaused(
        bool _paused
    ) external onlyRole(PAUSER_ROLE) {
        require(
            isInstantWithdrawPaused != _paused,
            "Admin: Already in that state"
        );

        isInstantWithdrawPaused = _paused;

        emit InstantWithdrawPaused(_paused);
    }

    // --- Strategy Management Functions ---

    function setStrategyContract(
        address _strategyAddress
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            _strategyAddress != address(0),
            "Admin: Strategy address cannot be zero"
        );
        address oldStrategy = strategyContract;
        strategyContract = _strategyAddress;
        emit StrategyContractUpdated(oldStrategy, _strategyAddress);
    }

    /**
     * @notice Adds a new validator to the Strategy contract's whitelist.
     * @dev Can only be called by an account with the VALIDATOR_MANAGER_ROLE.
     * @dev NOTE: _validator must be in EVM format (0x...) not Cosmos bech32.
     */
    function addValidatorToStrategy(
        address _validator
    ) external onlyRole(VALIDATOR_MANAGER_ROLE) {
        require(
            strategyContract != address(0),
            "Admin: Strategy contract not set"
        );
        require(
            _validator != address(0),
            "Admin: Validator address cannot be zero"
        );
        IStrategy(strategyContract).addValidator(_validator);
        emit ValidatorAdded(_validator);
    }

    /**
     * @notice Removes a validator from the Strategy contract's whitelist.
     * @dev Can only be called by an account with the VALIDATOR_MANAGER_ROLE.
     * @dev NOTE: _validator must be in EVM format (0x...) not Cosmos bech32.
     */
    function removeValidatorFromStrategy(
        address _validator
    ) external onlyRole(VALIDATOR_MANAGER_ROLE) {
        require(
            strategyContract != address(0),
            "Admin: Strategy contract not set"
        );
        require(
            _validator != address(0),
            "Admin: Validator address cannot be zero"
        );
        IStrategy(strategyContract).removeValidator(_validator);
        emit ValidatorRemoved(_validator);
    }

    // --- Fee Management Functions ---

    function setBridgeFee(
        uint256 _newFeeBps
    ) external onlyRole(FEE_MANAGER_ROLE) {
        require(
            _newFeeBps <= MAX_BRIDGE_FEE_BPS,
            "Admin: Fee exceeds maximum allowed"
        );
        bridgeFeeBps = _newFeeBps;
        emit BridgeFeeUpdated(_newFeeBps);
    }

    function setStakingFee(
        uint256 _newFeeBps
    ) external onlyRole(FEE_MANAGER_ROLE) {
        require(
            _newFeeBps <= MAX_STAKING_FEE_BPS,
            "Admin: Staking fee exceeds maximum"
        );
        stakingFeeBps = _newFeeBps;
        emit StakingFeeUpdated(_newFeeBps);
    }

    function setTreasuryAddress(
        address _newTreasury
    ) external onlyRole(FEE_MANAGER_ROLE) {
        require(
            _newTreasury != address(0),
            "Admin: Treasury address cannot be zero"
        );
        address oldTreasury = treasuryAddress;
        treasuryAddress = _newTreasury;
        emit TreasuryAddressUpdated(oldTreasury, _newTreasury);
    }

    // --- AMM Management Functions ---

    function setAmmContracts(
        address _factory,
        address _router
    ) external onlyRole(AMM_MANAGER_ROLE) {
        require(
            _factory != address(0),
            "Admin: AMM Factory address cannot be zero"
        );
        require(
            _router != address(0),
            "Admin: AMM Router address cannot be zero"
        );
        address oldFactory = ammFactory;
        address oldRouter = ammRouter;
        ammFactory = _factory;
        ammRouter = _router;
        emit AmmParametersUpdated(oldFactory, oldRouter, _factory, _router);
    }

    function setAmmSwapFee(
        uint256 _newFeeBps
    ) external onlyRole(AMM_MANAGER_ROLE) {
        require(
            _newFeeBps <= MAX_AMM_FEE_BPS,
            "Admin: AMM fee exceeds maximum allowed"
        );
        ammSwapFeeBps = _newFeeBps;
        emit AmmSwapFeeUpdated(_newFeeBps);
    }

    // --- Role Management Functions ---

    /**
     * @notice Allows an admin to renounce their own admin role.
     * @dev This is a one-way action and cannot be undone.
     */
    function renounceAdmin() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address admin = _msgSender();
        _revokeRole(DEFAULT_ADMIN_ROLE, admin);
        emit AdminRenounced(admin);
    }

    /**
     * @notice A helper function for a clean transfer of the main admin role.
     * @dev The new admin must be a non-zero address.
     */
    function transferAdmin(
        address newAdmin
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            newAdmin != address(0),
            "Admin: New admin cannot be zero address"
        );
        address oldAdmin = _msgSender();

        // Grant all roles to the new admin
        _grantRole(DEFAULT_ADMIN_ROLE, newAdmin);
        _grantRole(PAUSER_ROLE, newAdmin);
        _grantRole(VALIDATOR_MANAGER_ROLE, newAdmin);
        _grantRole(FEE_MANAGER_ROLE, newAdmin);
        _grantRole(AMM_MANAGER_ROLE, newAdmin);

        // Revoke all roles from the old admin
        _revokeRole(DEFAULT_ADMIN_ROLE, oldAdmin);
        _revokeRole(PAUSER_ROLE, oldAdmin);
        _revokeRole(VALIDATOR_MANAGER_ROLE, oldAdmin);
        _revokeRole(FEE_MANAGER_ROLE, oldAdmin);
        _revokeRole(AMM_MANAGER_ROLE, oldAdmin);

        emit AdminTransferred(oldAdmin, newAdmin);
    }

    // --- Emergency/Recovery Functions ---

    /**
     * @notice Allows the admin to recover any ERC20 tokens accidentally sent to this contract.
     * @param token The address of the ERC20 token to recover.
     * @param amount The amount of tokens to recover.
     * @param to The address to send the recovered tokens to.
     */
    function recoverERC20(
        address token,
        uint256 amount,
        address to
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(to != address(0), "Admin: Recovery address cannot be zero");
        IERC20(token).transfer(to, amount);
        emit ERC20Recovered(token, to, amount);
    }

    // --- View Functions ---

    /**
     * @notice A getter to allow off-chain tools to easily fetch all role hashes.
     */
    function getRoles()
        external
        pure
        returns (bytes32, bytes32, bytes32, bytes32)
    {
        return (
            PAUSER_ROLE,
            VALIDATOR_MANAGER_ROLE,
            FEE_MANAGER_ROLE,
            AMM_MANAGER_ROLE
        );
    }

    /**
     * @notice A public view function to check if an account has a specific role.
     * @dev Useful for UI and off-chain tools to check permissions.
     */
    function hasRole(
        bytes32 role,
        address account
    ) public view override returns (bool) {
        return super.hasRole(role, account);
    }
}
