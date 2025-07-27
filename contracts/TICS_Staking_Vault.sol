// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol"; // Import Math for min/max
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// --- Interfaces ---
interface IAdmin {
    function stakingFeeBps() external view returns (uint256);
    function treasuryAddress() external view returns (address);
    function isStakingPaused() external view returns (bool);
    function isInstantWithdrawPaused() external view returns (bool);
    function hasRole(
        bytes32 role,
        address account
    ) external view returns (bool);
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);
    function KEEPER_ROLE() external view returns (bytes32);
}

interface IZTICS is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function decimals() external view returns (uint8);
}

interface IUnbondingManager {
    struct UnbondingPosition {
        address user;
        uint256 principalAmount;
        uint256 rewardAmount;
        uint256 unbondingStartTime;
        uint256 rewardVestingStartDate;
        uint256 rewardVestingEndDate;
        uint256 claimedRewards;
        bool principalClaimed;
        bool rewardVestingDateFinalized;
    }

    function createUnbondingPosition(
        address _user,
        uint256 _principalAmount,
        uint256 _rewardAmount,
        uint256 _provisionalVestingStartDate,
        bool _rewardVestingDateFinalized
    ) external returns (uint256 tokenId);

    function processPrincipalClaim(
        uint256 _tokenId
    ) external returns (uint256 amountToClaim, bool shouldBurnNFT);

    function processVestedRewardsClaim(
        uint256 _tokenId
    ) external returns (uint256 amountToClaim, bool shouldBurnNFT);

    function finalizeRewardVestingDate(
        uint256 _tokenId,
        uint256 _actualVestingStartDate
    ) external;

    function adminBurnOrphanedNFT(uint256 _tokenId) external;
    function burnNFT(uint256 _tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getUnbondingPosition(
        uint256 _tokenId
    )
        external
        view
        returns (
            address user,
            uint256 principalAmount,
            uint256 rewardAmount,
            uint256 unbondingStartTime,
            uint256 rewardVestingStartDate,
            uint256 rewardVestingEndDate,
            uint256 claimedRewards,
            bool principalClaimed,
            bool rewardVestingDateFinalized
        );
    function getClaimableVestedRewards(
        uint256 _tokenId
    ) external view returns (uint256);
    function rewardsUnlockTimestamp() external view returns (uint256);
    function REWARD_VESTING_DURATION() external view returns (uint256);
    function UNBONDING_PERIOD() external view returns (uint256);
    function MAX_VESTING_START_DATE_EXTENSION() external view returns (uint256);
}

interface IBoostVault {
    struct UserBoostInfo {
        uint256 amount;
        uint256 rewardDebt;
    }

    function stakeZtics(address _user, uint256 _amount) external;
    function unstakeZtics(uint256 _amount) external;
    function claimPoints() external;
    function pendingPoints(address _user) external view returns (uint256);
    function getUserStakeInfo(
        address _user
    ) external view returns (uint256 amount, uint256 rewardDebt);
    function isBoostVaultPaused() external view returns (bool);
    function setPointsPerSecond(uint256 _newRate) external;
    function setBoostVaultPause(bool _paused) external;
    function stakeZticsForUser(address _user, uint256 _amount) external;
}

contract TICS_Staking_Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IZTICS;
    using EnumerableSet for EnumerableSet.AddressSet;

    // --- Structs ---
    struct WithdrawalDetails {
        uint256 principalAmount;
        uint256 principalClaimTime;
        uint256 rewardAmount;
        uint256 rewardVestingStartDate;
        uint256 rewardVestingEndDate;
        uint256 claimedRewards;
        bool principalClaimed;
        bool rewardVestingDateFinalized;
    }

    // --- State Variables ---
    IAdmin public immutable adminContract;
    IZTICS public immutable zTICSContract;
    IUnbondingManager public immutable unbondingManager;
    IBoostVault public immutable boostVault;

    uint256 public totalStakedTICS;
    uint256 public pendingDelegationTICS;
    uint256 public pendingUnbondingTICS;
    uint256 public unclaimedLockedRewards;
    uint256 public totalPrincipal;
    mapping(address => uint256) public claimableLockedRewards;

    // --- Qubetics Lockup & Snapshot ---
    uint256 public immutable rewardsUnlockTimestamp;
    uint256 public rewardsNormalizationDate;
    uint256 public lastDelegationTimestamp;

    // NEW: Snapshot variables
    uint256 public snapshotExchangeRate;
    uint256 public snapshotTimestamp;
    uint256 public immutable MAX_CONFIG_DATE; // Max date for taking the snapshot

    // --- Constants ---
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 private constant PRECISION = 1e18;
    uint256 public constant INSTANT_WITHDRAWAL_FEE_BPS = 100;
    uint256 public constant DELEGATION_COOLDOWN = 6 hours;

    // --- Events ---
    event Deposited(
        address indexed user,
        uint256 ticsAmount,
        uint256 zTicsMinted
    );
    event WithdrawalRequested(
        address indexed user,
        uint256 ticsAmount,
        uint256 zTicsBurned,
        uint256 tokenId,
        uint256 principalAmount,
        uint256 rewardAmount
    );
    event InstantWithdrawal(
        address indexed user,
        uint256 ticsAmount,
        uint256 fee
    );
    event PrincipalClaimed(
        address indexed user,
        uint256 ticsAmount,
        uint256 tokenId
    );
    event RewardsClaimedFromNFT(
        address indexed user,
        uint256 amount,
        uint256 tokenId
    );
    event LockedRewardsClaimed(address indexed user, uint256 rewardsAmount);
    event LockedRewardAllocated(address indexed user, uint256 amount);
    event DelegationTriggered(uint256 amountDelegated, uint256 timestamp);
    event UnclaimedRewardsUpdated(uint256 newTotalAccruedRewards);
    event RewardsNormalizationDateSet(uint256 newDate);
    event RewardsCompounded(uint256 rewardsAmount, uint256 feesCollected);
    event RewardSnapshotTaken(uint256 exchangeRate, uint256 timestamp);

    constructor(
        address _adminAddress,
        address _zTICSAddress,
        address _unbondingManagerAddress,
        address _boostVaultAddress,
        uint256 _rewardsUnlockTimestamp
    ) {
        adminContract = IAdmin(_adminAddress);
        zTICSContract = IZTICS(_zTICSAddress);
        unbondingManager = IUnbondingManager(_unbondingManagerAddress);
        boostVault = IBoostVault(_boostVaultAddress);
        rewardsUnlockTimestamp = _rewardsUnlockTimestamp;
        rewardsNormalizationDate = 0;
        lastDelegationTimestamp = 0;

        MAX_CONFIG_DATE = block.timestamp + 181 days;
    }

    // --- Snapshot Function ---
    function takeRewardSnapshot() external {
        require(
            adminContract.hasRole(
                adminContract.DEFAULT_ADMIN_ROLE(),
                msg.sender
            ),
            "Admin only"
        );
        require(
            block.timestamp < MAX_CONFIG_DATE,
            "Configuration period has ended"
        );

        snapshotExchangeRate = getTicsByZTics(PRECISION);
        snapshotTimestamp = block.timestamp;

        emit RewardSnapshotTaken(snapshotExchangeRate, snapshotTimestamp);
    }

    // --- Core Staking Functions ---
    function deposit(uint256 _minZticsToMint) external payable nonReentrant {
        require(
            !adminContract.isStakingPaused(),
            "Vault: New deposits are paused"
        );
        require(msg.value > 0, "Vault: Cannot deposit zero TICS");
        uint256 _amount = msg.value;
        uint256 zTicsToMint = getZTicsByTics(_amount);
        require(
            zTicsToMint >= _minZticsToMint,
            "Vault: Slippage check failed, received too few zTICS"
        );
        pendingDelegationTICS += _amount;
        totalPrincipal += _amount;
        zTICSContract.mint(msg.sender, zTicsToMint);
        emit Deposited(msg.sender, _amount, zTicsToMint);
    }

    function withdraw(
        uint256 _zTicsAmount
    ) external nonReentrant returns (uint256 tokenId) {
        require(_zTicsAmount > 0, "Vault: Cannot withdraw zero zTICS");
        (uint256 stakedBoostZtics, ) = boostVault.getUserStakeInfo(msg.sender);
        require(stakedBoostZtics == 0, "Vault: Unstake from Boost Vault first");

        uint256 currentTicsValue = getTicsByZTics(_zTicsAmount); // Current TICS value of zTICS being burned
        // Removed the restrictive liquidity check here to allow withdrawal into the queue
        // require(
        //     currentTicsValue <= (pendingDelegationTICS + totalStakedTICS),
        //     "Vault: Insufficient liquid or actively staked TICS for withdrawal"
        // );

        uint256 principalForNFT; // Principal portion for the Unbonding NFT
        uint256 rewardsForNFT; // Rewards portion for the Unbonding NFT
        uint256 vestingStartDate;
        bool rewardVestingDateFinalized;

        if (snapshotTimestamp == 0) {
            // Before snapshot, rewards are simply the current gain.
            // If currentTicsValue is less than _zTicsAmount, no rewards, principalForNFT absorbs the loss.
            if (currentTicsValue > _zTicsAmount) {
                rewardsForNFT = currentTicsValue - _zTicsAmount;
                principalForNFT = _zTicsAmount; // Original principal
            } else {
                rewardsForNFT = 0;
                principalForNFT = currentTicsValue; // Principal reduced due to loss
            }
            vestingStartDate = (block.timestamp < rewardsUnlockTimestamp)
                ? rewardsUnlockTimestamp
                : block.timestamp;
            rewardVestingDateFinalized = false;
        } else {
            // After snapshot, split gain into vested rewards and principal portion.
            uint256 ticsValueAtSnapshot = (_zTicsAmount *
                snapshotExchangeRate) / PRECISION;

            // Vested rewards are gains up to the snapshot.
            uint256 vestedRewardsFromSnapshot = 0;
            if (ticsValueAtSnapshot > _zTicsAmount) {
                vestedRewardsFromSnapshot = ticsValueAtSnapshot - _zTicsAmount;
            }

            // rewardsForNFT is capped by vestedRewardsFromSnapshot.
            rewardsForNFT = vestedRewardsFromSnapshot;

            // principalForNFT is the current total value minus the rewards that are vested.
            // This means any post-snapshot gains/losses are absorbed by the principal portion of the NFT.
            principalForNFT = currentTicsValue - rewardsForNFT;

            vestingStartDate = snapshotTimestamp;
            rewardVestingDateFinalized = true;
        }

        // Deduct only the principalForNFT portion from pendingDelegationTICS or totalStakedTICS.
        // This ensures that the immediate liquid/staked pool is only reduced by the principal portion
        // of the withdrawal. The rewards portion is a claim against the overall vault yield.
        if (principalForNFT <= pendingDelegationTICS) {
            pendingDelegationTICS -= principalForNFT;
        } else {
            uint256 remainingPrincipalToDeduct = principalForNFT -
                pendingDelegationTICS;
            pendingDelegationTICS = 0;
            // Ensure totalStakedTICS does not underflow by capping deduction at its current value
            totalStakedTICS -= Math.min(
                totalStakedTICS,
                remainingPrincipalToDeduct
            );
        }

        // The amount to deduct from totalPrincipal should be the original principal equivalent
        // of the zTICS burned, adjusted for any overall protocol loss.
        // If currentTicsValue is less than _zTicsAmount, it means the protocol is underwater,
        // so the principal leaving is effectively currentTicsValue. Otherwise, it's the original _zTicsAmount.
        uint256 principalToDeductFromTotalPrincipal = Math.min(
            _zTicsAmount,
            currentTicsValue
        );
        totalPrincipal -= principalToDeductFromTotalPrincipal;

        pendingUnbondingTICS += principalForNFT; // Use principalForNFT for unbonding

        zTICSContract.burn(msg.sender, _zTicsAmount);

        tokenId = unbondingManager.createUnbondingPosition(
            msg.sender,
            principalForNFT, // Use the calculated principal for NFT
            rewardsForNFT, // Use the calculated rewards for NFT
            vestingStartDate,
            rewardVestingDateFinalized
        );

        emit WithdrawalRequested(
            msg.sender,
            currentTicsValue, // Emitting currentTicsValue (total value of withdrawal)
            _zTicsAmount,
            tokenId,
            principalForNFT, // Emitting principal portion for NFT
            rewardsForNFT // Emitting rewards portion for NFT
        );
    }

    function instantWithdraw(
        uint256 _zTicsAmount,
        uint256 _minExpectedTics
    ) external nonReentrant {
        require(
            !adminContract.isInstantWithdrawPaused(),
            "Vault: Instant withdrawal is paused"
        );
        require(_zTicsAmount > 0, "Vault: Cannot withdraw zero zTICS");
        (uint256 stakedBoostZtics, ) = boostVault.getUserStakeInfo(msg.sender);
        require(stakedBoostZtics == 0, "Vault: Unstake from Boost Vault first");
        uint256 ticsToReceive = getTicsByZTics(_zTicsAmount);
        require(
            pendingDelegationTICS >= ticsToReceive,
            "Vault: Insufficient liquid buffer for instant withdrawal"
        );
        uint256 fee = (ticsToReceive * INSTANT_WITHDRAWAL_FEE_BPS) / 10000;
        uint256 amountToUser = ticsToReceive - fee;
        require(
            amountToUser >= _minExpectedTics,
            "Vault: Slippage check failed, received too few TICS"
        );
        pendingDelegationTICS -= ticsToReceive;
        totalPrincipal -= ticsToReceive; // This deduction is fine for instant withdraw as it is a full withdrawal
        zTICSContract.burn(msg.sender, _zTicsAmount);
        payable(adminContract.treasuryAddress()).transfer(fee);
        payable(msg.sender).transfer(amountToUser);
        emit InstantWithdrawal(msg.sender, amountToUser, fee);
    }

    function claimPrincipal(uint256 _tokenId) external nonReentrant {
        require(
            unbondingManager.ownerOf(_tokenId) == msg.sender,
            "Vault: Not owner of this NFT"
        );
        (uint256 amountToClaim, bool shouldBurnNFT) = unbondingManager
            .processPrincipalClaim(_tokenId);
        require(amountToClaim > 0, "Vault: No principal to claim for this NFT");
        pendingUnbondingTICS -= amountToClaim;
        payable(msg.sender).transfer(amountToClaim);
        emit PrincipalClaimed(msg.sender, amountToClaim, _tokenId);
        if (shouldBurnNFT) {
            unbondingManager.burnNFT(_tokenId);
        }
    }

    function claimVestedRewards(uint256 _tokenId) external nonReentrant {
        require(
            unbondingManager.ownerOf(_tokenId) == msg.sender,
            "Vault: Not owner of this NFT"
        );
        (uint256 amountToClaim, bool shouldBurnNFT) = unbondingManager
            .processVestedRewardsClaim(_tokenId);
        require(amountToClaim > 0, "Vault: No new vested rewards to claim");
        payable(msg.sender).transfer(amountToClaim);
        emit RewardsClaimedFromNFT(msg.sender, amountToClaim, _tokenId);
        if (shouldBurnNFT) {
            unbondingManager.burnNFT(_tokenId);
        }
    }

    function claimLockedRewards() external nonReentrant {
        uint256 amountToClaim = claimableLockedRewards[msg.sender];
        require(amountToClaim > 0, "Vault: No locked rewards to claim");

        claimableLockedRewards[msg.sender] = 0;

        payable(msg.sender).transfer(amountToClaim);

        emit LockedRewardsClaimed(msg.sender, amountToClaim);
    }

    function stakeZtics(uint256 _amount) external nonReentrant {
        boostVault.stakeZtics(msg.sender, _amount);
    }

    function unstakeZtics(uint256 _amount) external nonReentrant {
        boostVault.unstakeZtics(_amount);
    }

    function oneClickStakeAndBoost(
        uint256 _minZticsToMint
    ) external payable nonReentrant {
        require(
            !adminContract.isStakingPaused(),
            "Vault: Staking is currently paused"
        );
        require(msg.value > 0, "Vault: Cannot deposit zero TICS");

        uint256 _ticsAmount = msg.value;
        uint256 zTicsToMint = getZTicsByTics(_ticsAmount);
        require(
            zTicsToMint >= _minZticsToMint,
            "Vault: Slippage check failed, received too few zTICS"
        );

        pendingDelegationTICS += _ticsAmount;
        totalPrincipal += _ticsAmount;

        zTICSContract.mint(address(boostVault), zTicsToMint);
        boostVault.stakeZticsForUser(msg.sender, zTicsToMint);

        emit Deposited(msg.sender, _ticsAmount, zTicsToMint);
    }

    function claimPoints() external nonReentrant {
        boostVault.claimPoints();
    }

    // --- View Functions ---

    /**
     * @notice Returns the total value of all TICS managed by the protocol (TVL).
     * This includes actively staked, pending delegation, pending unbonding, and unclaimed rewards.
     */
    function getVaultTVL() public view returns (uint256) {
        return
            totalStakedTICS +
            pendingDelegationTICS +
            pendingUnbondingTICS +
            unclaimedLockedRewards;
    }

    /**
     * @notice Returns the value of TICS actively backing the current zTICS supply.
     * This is used to calculate the zTICS exchange rate and excludes TICS in the unbonding phase.
     */
    function getTotalActiveTICS() public view returns (uint256) {
        return totalStakedTICS + pendingDelegationTICS + unclaimedLockedRewards;
    }

    function getTicsByZTics(
        uint256 _zTicsAmount
    ) public view returns (uint256) {
        uint256 totalSupply = zTICSContract.totalSupply();
        if (totalSupply == 0) return _zTicsAmount;
        // Use getTotalActiveTICS for the conversion calculation
        return Math.mulDiv(_zTicsAmount, getTotalActiveTICS(), totalSupply);
    }

    function getZTicsByTics(uint256 _ticsAmount) public view returns (uint256) {
        uint256 totalSupply = zTICSContract.totalSupply();
        if (totalSupply == 0) return _ticsAmount;
        // Use getTotalActiveTICS for the conversion calculation
        uint256 activeTICS = getTotalActiveTICS();
        if (activeTICS == 0) return _ticsAmount; // Prevent division by zero if pool is empty
        return Math.mulDiv(_ticsAmount, totalSupply, activeTICS);
    }

    function pendingPoints(address _user) public view returns (uint256) {
        return boostVault.pendingPoints(_user);
    }

    function getUserBoostInfo(
        address _user
    ) public view returns (uint256 stakedZtics, uint256 _pendingPoints) {
        (uint256 amount, ) = boostVault.getUserStakeInfo(_user);
        uint256 points = boostVault.pendingPoints(_user);
        return (amount, points);
    }

    function getPendingWithdrawal(
        uint256 _tokenId
    ) public view returns (WithdrawalDetails memory details) {
        (
            ,
            uint256 principalAmountFromUM,
            uint256 rewardAmountFromUM,
            uint256 unbondingStartTimeFromUM,
            uint256 rewardVestingStartDateFromUM,
            uint256 rewardVestingEndDateFromUM,
            uint256 claimedRewardsFromUM,
            bool principalClaimedFromUM,
            bool rewardVestingDateFinalizedFromUM
        ) = unbondingManager.getUnbondingPosition(_tokenId);

        details.principalAmount = principalAmountFromUM;
        details.principalClaimTime =
            unbondingStartTimeFromUM +
            unbondingManager.UNBONDING_PERIOD();
        details.rewardAmount = rewardAmountFromUM;
        details.rewardVestingStartDate = rewardVestingStartDateFromUM;
        details.rewardVestingEndDate = rewardVestingEndDateFromUM;
        details.claimedRewards = claimedRewardsFromUM;
        details.principalClaimed = principalClaimedFromUM;
        details.rewardVestingDateFinalized = rewardVestingDateFinalizedFromUM;

        return details;
    }

    function getClaimableVestedRewards(
        uint256 _tokenId
    ) public view returns (uint256 claimable) {
        return unbondingManager.getClaimableVestedRewards(_tokenId);
    }

    // --- Keeper & Admin Functions ---
    modifier onlyKeeper() {
        require(
            adminContract.hasRole(KEEPER_ROLE, msg.sender),
            "Vault: Caller is not a keeper"
        );
        _;
    }

    function updateUnclaimedRewards(
        uint256 _newTotalAccruedRewards
    ) external onlyKeeper {
        unclaimedLockedRewards = _newTotalAccruedRewards;
        emit UnclaimedRewardsUpdated(_newTotalAccruedRewards);
    }

    function setRewardsNormalizationDate(
        uint256 _newNormalizationDate
    ) external {
        require(
            adminContract.hasRole(
                adminContract.DEFAULT_ADMIN_ROLE(),
                msg.sender
            ),
            "Admin only"
        );
        require(
            _newNormalizationDate > block.timestamp,
            "Vault: Normalization date must be in the future"
        );
        rewardsNormalizationDate = _newNormalizationDate;
        emit RewardsNormalizationDateSet(_newNormalizationDate);
    }

    function finalizeRewardVestingDate(
        uint256 _tokenId,
        uint256 _actualVestingStartDate
    ) external onlyKeeper {
        unbondingManager.finalizeRewardVestingDate(
            _tokenId,
            _actualVestingStartDate
        );
    }

    function adminBurnOrphanedNFT(uint256 _tokenId) external {
        require(
            adminContract.hasRole(
                adminContract.DEFAULT_ADMIN_ROLE(),
                msg.sender
            ),
            "Admin only"
        );
        unbondingManager.adminBurnOrphanedNFT(_tokenId);
    }

    function triggerDelegation() external onlyKeeper {
        require(
            block.timestamp >= lastDelegationTimestamp + DELEGATION_COOLDOWN,
            "Vault: Delegation cooldown active"
        );

        uint256 amountToDelegate = pendingDelegationTICS;
        if (amountToDelegate > 0) {
            totalStakedTICS += amountToDelegate;
            pendingDelegationTICS = 0;
            lastDelegationTimestamp = block.timestamp;
            emit DelegationTriggered(amountToDelegate, block.timestamp);
        }
    }

    function processUnlockedRewards() external onlyKeeper {
        require(
            block.timestamp >= rewardsUnlockTimestamp,
            "Vault: Rewards are still locked"
        );

        uint256 rewards = unclaimedLockedRewards;

        if (rewards > 0) {
            uint256 fee = (rewards * adminContract.stakingFeeBps()) / 10000;
            uint256 netRewards = rewards - fee;

            if (fee > 0) {
                payable(adminContract.treasuryAddress()).transfer(fee);
            }

            totalStakedTICS += netRewards;
            unclaimedLockedRewards = 0;
            emit RewardsCompounded(netRewards, fee);
        }
    }

    function setPointsPerSecond(uint256 _newRate) external {
        require(
            adminContract.hasRole(
                adminContract.DEFAULT_ADMIN_ROLE(),
                msg.sender
            ),
            "Admin only"
        );
        boostVault.setPointsPerSecond(_newRate);
    }

    function setBoostVaultPause(bool _paused) external {
        require(
            adminContract.hasRole(
                adminContract.DEFAULT_ADMIN_ROLE(),
                msg.sender
            ),
            "Admin only"
        );
        boostVault.setBoostVaultPause(_paused);
    }
}
