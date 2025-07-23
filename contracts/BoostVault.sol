// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

// --- Interfaces ---
interface IAdmin {
    function hasRole(
        bytes32 role,
        address account
    ) external view returns (bool);
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);
}

// Interface for EIP-2612 permit functionality
interface IPermit is IERC20 {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * @title ZoopX Boost Vault (Enhanced Dynamic APY)
 * @author ZoopX Labs
 * @notice This contract manages the staking of zTICS to earn ZoopX Points via a dynamic APY
 * that is inversely proportional to the Total Value Locked (TVL). It includes granular security controls,
 * detailed events for analytics, and support for gasless approvals via EIP-2612 permits.
 * @dev All zTICS deposits can only be withdrawn by the original depositor to their own address.
 * Unstaking can never be paused by an admin.
 */
contract BoostVault is ReentrancyGuard {
    using SafeERC20 for IPermit;

    // --- State Variables ---
    IAdmin public immutable adminContract;
    IPermit public immutable zTICSContract;
    // FIX: Made the address mutable to break the circular dependency.
    address public ticsStakingVault;

    mapping(address => UserBoostInfo) public boostVaultInfo;
    uint256 public totalBoostVaultStaked;
    uint256 public accumulatedPointsPerShare;
    uint256 public lastRewardTimestamp;
    mapping(address => uint256) public claimablePoints;
    uint256 public totalClaimedPoints; // Global tracker for all points claimed

    // --- Dynamic APY Parameters ---
    uint256 public targetTvl;
    uint256 public constant MAX_APY_BPS = 7000;
    uint256 public constant MIN_APY_BPS = 3000;
    uint256 private constant BPS_DIVISOR = 10000;
    uint256 private constant SECONDS_IN_YEAR = 31_536_000;
    uint256 private constant PRECISION = 1e18;

    // --- Granular Pausing Status ---
    VaultStatus public vaultStatus;
    struct VaultStatus {
        bool stakePaused;
        bool claimPaused;
    }

    // --- Structs ---
    struct UserBoostInfo {
        uint256 amount;
        uint256 rewardDebt;
    }

    // --- Events ---
    event ZticsStaked(address indexed user, uint256 amount);
    event ZticsUnstaked(address indexed user, uint256 amount);
    event PointsClaimed(address indexed user, uint256 amount);
    event PointsUpdated(address indexed user, uint256 newTotalPoints);
    event TargetTvlUpdated(uint256 newTargetTvl);
    event VaultStatusChanged(bool stakePaused, bool claimPaused);
    event VaultStateUpdated(
        uint256 newTotalTvl,
        uint256 newApyBps,
        uint256 timestamp
    );
    event AccPointsPerShareUpdated(
        uint256 newAccPointsPerShare,
        uint256 timestamp
    );
    event TicsStakingVaultSet(address indexed vaultAddress); // NEW EVENT

    // --- Custom Errors ---
    error StakeIsPaused();
    error ClaimIsPaused();
    error ZeroAmount();
    error NoPointsToClaim();
    error InsufficientStakedBalance();
    error AdminOnly();
    error OnlyTICSStakingVault();
    error InvalidTargetTvl();
    error VaultAddressAlreadySet(); // NEW ERROR

    constructor(
        address _adminAddress,
        address _zTICSAddress,
        address _ticsStakingVaultAddress, // This parameter is now ignored but kept for ABI compatibility if needed.
        uint256 _initialTargetTvl
    ) {
        if (_initialTargetTvl == 0) revert InvalidTargetTvl();
        adminContract = IAdmin(_adminAddress);
        zTICSContract = IPermit(_zTICSAddress);
        // FIX: Removed assignment of immutable address from constructor.
        // ticsStakingVault = _ticsStakingVaultAddress;
        targetTvl = _initialTargetTvl;
        lastRewardTimestamp = block.timestamp;
    }

    // --- Modifiers ---
    modifier onlyAdmin() {
        if (
            !adminContract.hasRole(
                adminContract.DEFAULT_ADMIN_ROLE(),
                msg.sender
            )
        ) {
            revert AdminOnly();
        }
        _;
    }

    modifier onlyTICSStakingVault() {
        if (msg.sender != ticsStakingVault) revert OnlyTICSStakingVault();
        _;
    }

    // --- Public Functions ---

    /**
     * @notice FIX: New function to set the TICS_Staking_Vault address post-deployment.
     * @dev This breaks the circular dependency. Can only be called once by an admin.
     * @param _vaultAddress The address of the deployed TICS_Staking_Vault.
     */
    function setTicsStakingVault(address _vaultAddress) external onlyAdmin {
        if (ticsStakingVault != address(0)) revert VaultAddressAlreadySet();
        require(_vaultAddress != address(0), "Cannot set to zero address");
        ticsStakingVault = _vaultAddress;
        emit TicsStakingVaultSet(_vaultAddress);
    }

    function stakeZtics(uint256 _amount) external nonReentrant {
        if (vaultStatus.stakePaused) revert StakeIsPaused();
        if (_amount == 0) revert ZeroAmount();
        _stake(msg.sender, _amount);
    }

    function stakeWithPermit(
        uint256 _amount,
        uint256 _deadline,
        uint8 _v,
        bytes32 _r,
        bytes32 _s
    ) external nonReentrant {
        if (vaultStatus.stakePaused) revert StakeIsPaused();
        if (_amount == 0) revert ZeroAmount();

        zTICSContract.permit(
            msg.sender,
            address(this),
            _amount,
            _deadline,
            _v,
            _r,
            _s
        );
        _stake(msg.sender, _amount);
    }

    function stakeZticsForUser(
        address _user,
        uint256 _amount
    ) external nonReentrant onlyTICSStakingVault {
        if (vaultStatus.stakePaused) revert StakeIsPaused();
        if (_amount == 0) revert ZeroAmount();

        _updateAndSettlePoints(_user);

        UserBoostInfo storage user = boostVaultInfo[_user];
        user.amount += _amount;
        totalBoostVaultStaked += _amount;

        user.rewardDebt = (user.amount * accumulatedPointsPerShare) / PRECISION;

        emit ZticsStaked(_user, _amount);
        emit VaultStateUpdated(
            totalBoostVaultStaked,
            getCurrentApyBps(),
            block.timestamp
        );
    }

    function unstakeZtics(uint256 _amount) external nonReentrant {
        if (_amount == 0) revert ZeroAmount();

        UserBoostInfo storage user = boostVaultInfo[msg.sender];
        if (user.amount < _amount) revert InsufficientStakedBalance();

        _updateAndSettlePoints(msg.sender);

        user.amount -= _amount;
        totalBoostVaultStaked -= _amount;

        user.rewardDebt = (user.amount * accumulatedPointsPerShare) / PRECISION;

        zTICSContract.safeTransfer(msg.sender, _amount);

        emit ZticsUnstaked(msg.sender, _amount);
        emit VaultStateUpdated(
            totalBoostVaultStaked,
            getCurrentApyBps(),
            block.timestamp
        );
    }

    function claimPoints() external nonReentrant {
        if (vaultStatus.claimPaused) revert ClaimIsPaused();
        _updateAndSettlePoints(msg.sender);

        uint256 amountToClaim = claimablePoints[msg.sender];
        if (amountToClaim == 0) revert NoPointsToClaim();

        claimablePoints[msg.sender] = 0;
        totalClaimedPoints += amountToClaim;

        emit PointsClaimed(msg.sender, amountToClaim);
        emit PointsUpdated(msg.sender, 0);

        boostVaultInfo[msg.sender].rewardDebt =
            (boostVaultInfo[msg.sender].amount * accumulatedPointsPerShare) /
            PRECISION;
    }

    // --- View Functions ---

    function getCurrentApyBps() public view returns (uint256) {
        if (totalBoostVaultStaked == 0) return MAX_APY_BPS;
        uint256 apyRangeBps = MAX_APY_BPS - MIN_APY_BPS;
        uint256 tvlRatio = Math.min(
            (totalBoostVaultStaked * BPS_DIVISOR) / targetTvl,
            BPS_DIVISOR
        );
        return MAX_APY_BPS - (apyRangeBps * tvlRatio) / BPS_DIVISOR;
    }

    function pendingPoints(address _user) public view returns (uint256) {
        UserBoostInfo storage user = boostVaultInfo[_user];
        uint256 currentAccPointsPerShare = accumulatedPointsPerShare;
        uint256 currentTvl = totalBoostVaultStaked;

        if (block.timestamp > lastRewardTimestamp && currentTvl != 0) {
            uint256 timeElapsed = block.timestamp - lastRewardTimestamp;
            uint256 currentApy = getCurrentApyBps();
            uint256 totalPointsPerYear = (currentTvl * currentApy) /
                BPS_DIVISOR;
            uint256 newPoints = (totalPointsPerYear * timeElapsed) /
                SECONDS_IN_YEAR;
            currentAccPointsPerShare += (newPoints * PRECISION) / currentTvl;
        }

        uint256 unsettledPoints = ((user.amount * currentAccPointsPerShare) /
            PRECISION) - user.rewardDebt;
        return claimablePoints[_user] + unsettledPoints;
    }

    function previewUserRewards(
        address _user
    )
        external
        view
        returns (uint256 totalClaimablePoints, uint256 currentApyBps)
    {
        return (pendingPoints(_user), getCurrentApyBps());
    }

    function getUserStakeInfo(
        address _user
    ) external view returns (uint256 amount, uint256 rewardDebt) {
        UserBoostInfo storage user = boostVaultInfo[_user];
        return (user.amount, user.rewardDebt);
    }

    // --- Admin Functions ---

    function setTargetTvl(uint256 _newTargetTvl) external onlyAdmin {
        if (_newTargetTvl == 0) revert InvalidTargetTvl();
        _updateGlobalPoints();
        targetTvl = _newTargetTvl;
        emit TargetTvlUpdated(_newTargetTvl);
        emit VaultStateUpdated(
            totalBoostVaultStaked,
            getCurrentApyBps(),
            block.timestamp
        );
    }

    function setVaultStatus(
        bool _stakePaused,
        bool _claimPaused
    ) external onlyAdmin {
        vaultStatus.stakePaused = _stakePaused;
        vaultStatus.claimPaused = _claimPaused;
        emit VaultStatusChanged(_stakePaused, _claimPaused);
    }

    // --- Internal Functions ---

    function _stake(address _user, uint256 _amount) internal {
        _updateAndSettlePoints(_user);

        UserBoostInfo storage user = boostVaultInfo[_user];
        user.amount += _amount;
        totalBoostVaultStaked += _amount;

        user.rewardDebt = (user.amount * accumulatedPointsPerShare) / PRECISION;

        zTICSContract.safeTransferFrom(_user, address(this), _amount);

        emit ZticsStaked(_user, _amount);
        emit VaultStateUpdated(
            totalBoostVaultStaked,
            getCurrentApyBps(),
            block.timestamp
        );
    }

    function _updateAndSettlePoints(address _user) internal {
        _updateGlobalPoints();
        UserBoostInfo storage user = boostVaultInfo[_user];

        uint256 unsettledPoints = ((user.amount * accumulatedPointsPerShare) /
            PRECISION) - user.rewardDebt;

        if (unsettledPoints > 0) {
            claimablePoints[_user] += unsettledPoints;
            emit PointsUpdated(_user, claimablePoints[_user]);
        }
    }

    function _updateGlobalPoints() internal {
        if (block.timestamp <= lastRewardTimestamp) return;
        uint256 currentTvl = totalBoostVaultStaked;
        if (currentTvl == 0) {
            lastRewardTimestamp = block.timestamp;
            return;
        }

        uint256 timeElapsed = block.timestamp - lastRewardTimestamp;
        uint256 currentApy = getCurrentApyBps();
        uint256 totalPointsPerYear = (currentTvl * currentApy) / BPS_DIVISOR;
        uint256 newPoints = (totalPointsPerYear * timeElapsed) /
            SECONDS_IN_YEAR;

        if (newPoints > 0) {
            uint256 oldAccPointsPerShare = accumulatedPointsPerShare;
            accumulatedPointsPerShare += (newPoints * PRECISION) / currentTvl;
            if (accumulatedPointsPerShare != oldAccPointsPerShare) {
                emit AccPointsPerShareUpdated(
                    accumulatedPointsPerShare,
                    block.timestamp
                );
            }
        }

        lastRewardTimestamp = block.timestamp;
    }
}
