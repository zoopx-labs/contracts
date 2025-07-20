// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// --- Interfaces ---
interface IAdmin {
    function stakingFeeBps() external view returns (uint256);
    function treasuryAddress() external view returns (address);
    function isStakingPaused() external view returns (bool);
    function hasRole(
        bytes32 role,
        address account
    ) external view returns (bool);
}

interface IZTICS is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/**
 * @title ZoopX TICS Staking Vault
 * @author ZoopX Labs
 * @notice This is the core liquid staking contract for the ZoopX Protocol on Qubetics.
 * It manages TICS deposits, the issuance of zTICS, delegation to validators (via a Keeper),
 * and the Boost Vault for earning ZoopX Points with robust, per-user reward accounting.
 */
contract TICS_Staking_Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // --- Structs ---
    struct WithdrawalRequest {
        uint256 ticsAmount;
        uint256 completionTime;
    }

    struct UserBoostInfo {
        uint256 amount; // Amount of zTICS staked
        uint256 rewardDebt; // For calculating points owed
    }

    // --- State Variables ---
    IAdmin public immutable adminContract;
    IZTICS public immutable zTICSContract;
    IERC20 public immutable ticsToken;

    // Accounting for total TICS controlled by the protocol
    uint256 public totalStakedTICS;
    uint256 public pendingDelegationTICS;
    uint256 public pendingUnbondingTICS;
    uint256 public unclaimedLockedRewards;

    // Per-user mapping for principal and locked rewards
    mapping(address => uint256) public userPrincipal;
    mapping(address => uint256) public claimableLockedRewards;

    // Withdrawal queue
    mapping(address => WithdrawalRequest) public withdrawalRequests;
    EnumerableSet.AddressSet private usersWithPendingWithdrawals;

    // --- Boost Vault State ---
    mapping(address => UserBoostInfo) public boostVaultInfo;
    uint256 public totalBoostVaultStaked;
    uint256 public accumulatedPointsPerShare; // Reward tracking for points
    uint256 public pointsPerSecond; // Emission rate for ZoopX Points
    uint256 public lastRewardTimestamp; // Timestamp of the last points distribution update

    // --- Qubetics Lockup ---
    uint256 public immutable rewardsUnlockTimestamp;

    // --- Constants ---
    uint256 public constant UNBONDING_PERIOD = 14 days;
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 private constant PRECISION = 1e18;
    uint256 public constant INSTANT_WITHDRAWAL_FEE_BPS = 100; // 1%

    // --- Events ---
    event Deposited(
        address indexed user,
        uint256 ticsAmount,
        uint256 zTicsMinted
    );
    event WithdrawalRequested(
        address indexed user,
        uint256 ticsAmount,
        uint256 zTicsBurned
    );
    event InstantWithdrawal(
        address indexed user,
        uint256 ticsAmount,
        uint256 fee
    );
    event WithdrawalClaimed(address indexed user, uint256 ticsAmount);
    event LockedRewardsClaimed(address indexed user, uint256 rewardsAmount);
    event LockedRewardAllocated(address indexed user, uint256 amount);
    event ZticsStaked(address indexed user, uint256 amount);
    event ZticsUnstaked(address indexed user, uint256 amount);
    event PointsClaimed(address indexed user, uint256 pointsAmount);
    event RewardsCompounded(uint256 rewardsAmount, uint256 feesCollected);
    event LockedRewardsUpdated(uint256 amount);
    event PointsEmissionRateUpdated(uint256 newRate);
    event DelegationTriggered(uint256 amountDelegated, uint256 timestamp);

    constructor(
        address _adminAddress,
        address _zTICSAddress,
        address _ticsAddress,
        uint256 _rewardsUnlockTimestamp
    ) {
        adminContract = IAdmin(_adminAddress);
        zTICSContract = IZTICS(_zTICSAddress);
        ticsToken = IERC20(_ticsAddress);
        rewardsUnlockTimestamp = _rewardsUnlockTimestamp;
        lastRewardTimestamp = block.timestamp;
    }

    // --- Core Staking Functions ---

    /**
     * @notice Deposits TICS into the vault and mints zTICS.
     * @param _amount The amount of TICS to deposit.
     */
    function deposit(uint256 _amount) external nonReentrant {
        require(
            !adminContract.isStakingPaused(),
            "Vault: New deposits are paused"
        );
        require(_amount > 0, "Vault: Cannot deposit zero TICS");

        uint256 zTicsToMint = getZTicsByTics(_amount);

        // State changes before external calls
        pendingDelegationTICS += _amount;
        userPrincipal[msg.sender] += _amount;

        ticsToken.safeTransferFrom(msg.sender, address(this), _amount);
        zTICSContract.mint(msg.sender, zTicsToMint);

        emit Deposited(msg.sender, _amount, zTicsToMint);
    }

    /**
     * @notice Initiates the standard 14-day withdrawal process by burning zTICS.
     * @param _zTicsAmount The amount of zTICS to burn.
     */
    function withdraw(uint256 _zTicsAmount) external nonReentrant {
        require(_zTicsAmount > 0, "Vault: Cannot withdraw zero zTICS");
        require(
            withdrawalRequests[msg.sender].ticsAmount == 0,
            "Vault: Existing withdrawal pending"
        );
        require(
            boostVaultInfo[msg.sender].amount == 0,
            "Vault: Unstake from Boost Vault first"
        );

        uint256 totalTicsValue = getTicsByZTics(_zTicsAmount);
        require(
            totalTicsValue <= getTotalTICSControlled(),
            "Vault: Insufficient protocol liquidity"
        );

        uint256 principalToWithdraw = Math.min(
            userPrincipal[msg.sender],
            totalTicsValue
        );
        uint256 rewardsToCredit = totalTicsValue - principalToWithdraw;

        // State changes before external calls
        userPrincipal[msg.sender] -= principalToWithdraw;
        totalStakedTICS -= totalTicsValue;

        uint256 amountToUnbond = principalToWithdraw;

        if (block.timestamp < rewardsUnlockTimestamp && rewardsToCredit > 0) {
            claimableLockedRewards[msg.sender] += rewardsToCredit;
            emit LockedRewardAllocated(msg.sender, rewardsToCredit);
        } else if (rewardsToCredit > 0) {
            // After lockup, rewards are added to the principal withdrawal
            amountToUnbond += rewardsToCredit;
        }

        pendingUnbondingTICS += amountToUnbond;

        withdrawalRequests[msg.sender] = WithdrawalRequest({
            ticsAmount: amountToUnbond,
            completionTime: block.timestamp + UNBONDING_PERIOD
        });
        usersWithPendingWithdrawals.add(msg.sender);

        zTICSContract.burn(msg.sender, _zTicsAmount);

        emit WithdrawalRequested(msg.sender, amountToUnbond, _zTicsAmount);
    }

    /**
     * @notice Allows a user to withdraw their TICS instantly from the staging pool, for a fee.
     * @param _zTicsAmount The amount of zTICS to burn for an instant withdrawal.
     */
    function instantWithdraw(uint256 _zTicsAmount) external nonReentrant {
        require(_zTicsAmount > 0, "Vault: Cannot withdraw zero zTICS");
        require(
            boostVaultInfo[msg.sender].amount == 0,
            "Vault: Unstake from Boost Vault first"
        );

        uint256 ticsToReceive = getTicsByZTics(_zTicsAmount);
        require(
            pendingDelegationTICS >= ticsToReceive,
            "Vault: Insufficient liquid buffer for instant withdrawal"
        );

        uint256 fee = (ticsToReceive * INSTANT_WITHDRAWAL_FEE_BPS) / 10000;
        uint256 amountToUser = ticsToReceive - fee;

        // State changes before external calls
        pendingDelegationTICS -= ticsToReceive;
        userPrincipal[msg.sender] -= Math.min(
            userPrincipal[msg.sender],
            amountToUser
        );

        zTICSContract.burn(msg.sender, _zTicsAmount);

        ticsToken.safeTransfer(adminContract.treasuryAddress(), fee);
        ticsToken.safeTransfer(msg.sender, amountToUser);

        emit InstantWithdrawal(msg.sender, amountToUser, fee);
    }

    /**
     * @notice Allows a user to claim their TICS after the standard unbonding period.
     */
    function claimWithdrawal() external nonReentrant {
        WithdrawalRequest storage request = withdrawalRequests[msg.sender];
        require(request.ticsAmount > 0, "Vault: No withdrawal request found");
        require(
            block.timestamp >= request.completionTime,
            "Vault: Unbonding period not over"
        );

        uint256 amountToClaim = request.ticsAmount;

        // State changes before external calls
        delete withdrawalRequests[msg.sender];
        usersWithPendingWithdrawals.remove(msg.sender);
        pendingUnbondingTICS -= amountToClaim;

        ticsToken.safeTransfer(msg.sender, amountToClaim);

        emit WithdrawalClaimed(msg.sender, amountToClaim);
    }

    /**
     * @notice Allows a user to claim their rewards that were locked during the initial network period.
     */
    function claimLockedRewards() external nonReentrant {
        uint256 amountToClaim = claimableLockedRewards[msg.sender];
        require(amountToClaim > 0, "Vault: No locked rewards to claim");

        // State changes before external calls
        claimableLockedRewards[msg.sender] = 0;

        ticsToken.safeTransfer(msg.sender, amountToClaim);

        emit LockedRewardsClaimed(msg.sender, amountToClaim);
    }

    // --- Boost Vault Functions ---

    /**
     * @notice Stakes zTICS into the Boost Vault to earn ZoopX Points.
     * @param _amount The amount of zTICS to stake.
     */
    function stakeZtics(uint256 _amount) external nonReentrant {
        _updateAndSettlePoints(msg.sender); // Settle pending points before changing stake

        // State changes before external calls
        UserBoostInfo storage user = boostVaultInfo[msg.sender];
        user.amount += _amount;
        user.rewardDebt = (user.amount * accumulatedPointsPerShare) / PRECISION;
        totalBoostVaultStaked += _amount;

        zTICSContract.safeTransferFrom(msg.sender, address(this), _amount);

        emit ZticsStaked(msg.sender, _amount);
    }

    /**
     * @notice Unstakes zTICS from the Boost Vault.
     * @param _amount The amount of zTICS to unstake.
     */
    function unstakeZtics(uint256 _amount) external nonReentrant {
        _updateAndSettlePoints(msg.sender); // Settle pending points before changing stake
        UserBoostInfo storage user = boostVaultInfo[msg.sender];
        require(user.amount >= _amount, "Vault: Insufficient staked balance");

        // State changes before external calls
        user.amount -= _amount;
        user.rewardDebt = (user.amount * accumulatedPointsPerShare) / PRECISION;
        totalBoostVaultStaked -= _amount;

        zTICSContract.safeTransfer(msg.sender, _amount);

        emit ZticsUnstaked(msg.sender, _amount);
    }

    /**
     * @notice Settles and records a user's accrued ZoopX Points.
     */
    function claimPoints() external {
        _updateAndSettlePoints(msg.sender);
    }

    // --- View Functions ---

    /**
     * @notice Gets the total value locked (TVL) of the vault.
     * @return The total TICS controlled by the protocol.
     */
    function getVaultTVL() public view returns (uint256) {
        return
            totalStakedTICS +
            pendingDelegationTICS +
            pendingUnbondingTICS +
            unclaimedLockedRewards;
    }

    /**
     * @notice Gets a breakdown of the protocol's liquidity across different states.
     * @return staged The amount of TICS in the pending delegation pool.
     * @return delegated The amount of TICS actively staked.
     * @return unbonding The amount of TICS in the unbonding period.
     */
    function getProtocolLiquidity()
        external
        view
        returns (uint256 staged, uint256 delegated, uint256 unbonding)
    {
        return (pendingDelegationTICS, totalStakedTICS, pendingUnbondingTICS);
    }

    /**
     * @notice Calculates the amount of TICS that corresponds to a given amount of zTICS.
     * @dev Note: The exchange rate changes over time as staking rewards are added to the vault.
     * @param _zTicsAmount The amount of zTICS.
     * @return The corresponding amount of TICS.
     */
    function getTicsByZTics(
        uint256 _zTicsAmount
    ) public view returns (uint256) {
        uint256 totalSupply = zTICSContract.totalSupply();
        if (totalSupply == 0) return _zTicsAmount;
        return Math.mulDiv(_zTicsAmount, getVaultTVL(), totalSupply);
    }

    /**
     * @notice Calculates the amount of zTICS that corresponds to a given amount of TICS.
     * @param _ticsAmount The amount of TICS.
     * @return The corresponding amount of zTICS.
     */
    function getZTicsByTics(uint256 _ticsAmount) public view returns (uint256) {
        uint256 totalSupply = zTICSContract.totalSupply();
        if (totalSupply == 0) return _ticsAmount;
        uint256 tvl = getVaultTVL();
        if (tvl == 0) return _ticsAmount;
        return Math.mulDiv(_ticsAmount, totalSupply, tvl);
    }

    /**
     * @notice Calculates the pending ZoopX Points for a user.
     * @param _user The address of the user.
     * @return The amount of points earned since the last interaction.
     */
    function pendingPoints(address _user) public view returns (uint256) {
        UserBoostInfo storage user = boostVaultInfo[_user];
        uint256 currentAccPointsPerShare = accumulatedPointsPerShare;

        if (
            block.timestamp > lastRewardTimestamp && totalBoostVaultStaked != 0
        ) {
            uint256 timeElapsed = block.timestamp - lastRewardTimestamp;
            uint256 newPoints = timeElapsed * pointsPerSecond;
            currentAccPointsPerShare +=
                (newPoints * PRECISION) /
                totalBoostVaultStaked;
        }

        return
            ((user.amount * currentAccPointsPerShare) / PRECISION) -
            user.rewardDebt;
    }

    // --- Internal & Keeper Functions ---

    modifier onlyKeeper() {
        require(
            adminContract.hasRole(KEEPER_ROLE, msg.sender),
            "Vault: Caller is not a keeper"
        );
        _;
    }

    function _updateAndSettlePoints(address _user) internal {
        uint256 pending = pendingPoints(_user);
        _updateGlobalPoints(); // Update global state first
        if (pending > 0) {
            // In a real system, you would transfer these points to a separate claimable mapping or contract.
            // For now, we just emit the event.
            emit PointsClaimed(_user, pending);
        }
        boostVaultInfo[_user].rewardDebt =
            (boostVaultInfo[_user].amount * accumulatedPointsPerShare) /
            PRECISION;
    }

    function _updateGlobalPoints() internal {
        if (block.timestamp <= lastRewardTimestamp) {
            return;
        }
        if (totalBoostVaultStaked == 0) {
            lastRewardTimestamp = block.timestamp;
            return;
        }
        uint256 timeElapsed = block.timestamp - lastRewardTimestamp;
        uint256 newPoints = timeElapsed * pointsPerSecond;
        accumulatedPointsPerShare +=
            (newPoints * PRECISION) /
            totalBoostVaultStaked;
        lastRewardTimestamp = block.timestamp;
    }

    function updateLockedRewards(uint256 _accruedAmount) external onlyKeeper {
        unclaimedLockedRewards = _accruedAmount;
        emit LockedRewardsUpdated(_accruedAmount);
    }

    /**
     * @notice Called by the Keeper Bot on a fixed schedule (e.g., every 6 hours).
     * It delegates all TICS currently held in the staging area (`pendingDelegationTICS`).
     */
    function triggerDelegation() external onlyKeeper {
        uint256 amountToDelegate = pendingDelegationTICS;
        if (amountToDelegate > 0) {
            // This function would use ICA to delegate the pendingDelegationTICS.
            totalStakedTICS += amountToDelegate;
            pendingDelegationTICS = 0;
            emit DelegationTriggered(amountToDelegate, block.timestamp);
        }
    }

    function triggerCompounding() external onlyKeeper {
        // The Keeper Bot is responsible for checking the network lockup period off-chain.
        uint256 rewards = unclaimedLockedRewards;

        if (rewards > 0) {
            uint256 fee = (rewards * adminContract.stakingFeeBps()) / 10000;
            uint256 netRewards = rewards - fee;

            if (fee > 0) {
                // This would require an ICA call to transfer fees
            }

            pendingDelegationTICS += netRewards;
            unclaimedLockedRewards = 0;
            emit RewardsCompounded(netRewards, fee);
        }
    }

    // --- Admin Functions ---

    /**
     * @notice Sets the emission rate for ZoopX Points.
     * @param _newRate The new number of points to be distributed per second.
     */
    function setPointsPerSecond(uint256 _newRate) external {
        require(
            adminContract.hasRole(
                adminContract.DEFAULT_ADMIN_ROLE(),
                msg.sender
            ),
            "Admin only"
        );
        _updateGlobalPoints();
        pointsPerSecond = _newRate;
        emit PointsEmissionRateUpdated(_newRate);
    }
}
