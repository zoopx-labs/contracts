// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol"; // Import Strings for toString()

/**
 * @title ZoopX Unbonding Manager
 * @author ZoopX Labs
 * @notice This contract manages the entire lifecycle of unbonding requests. It mints NFTs
 * to represent unbonding positions, handles the 14-day unbonding period, and processes
 * claims for both principal and vested rewards. It is owned by the TICS_Staking_Vault.
 */
contract UnbondingManager is ERC721Enumerable, Ownable {
    // --- Structs ---
    struct UnbondingPosition {
        address user; // The original user who initiated the unbonding
        uint256 principalAmount; // Original TICS principal requested for withdrawal
        uint256 rewardAmount; // Total rewards associated with this unbonding request
        uint256 unbondingStartTime; // When the unbonding period for principal began
        uint256 rewardVestingStartDate; // When linear vesting for rewards begins (provisional or finalized)
        uint256 rewardVestingEndDate; // When linear vesting for rewards ends (start date + 6 months)
        uint256 claimedRewards; // Amount of rewards already claimed
        bool principalClaimed; // Flag to track if principal has been claimed
        bool rewardVestingDateFinalized; // Flag to indicate if vesting start date has been finalized by Keeper
    }

    // --- State Variables ---
    uint256 private _nextTokenId; // Counter for unique NFT token IDs
    mapping(uint256 => UnbondingPosition) public unbondingPositions;

    // FIX: Made the address mutable to break the circular dependency.
    address public stakingVault;
    uint256 public immutable rewardsUnlockTimestamp; // Global rewards unlock timestamp from Vault
    uint256 public constant REWARD_VESTING_DURATION = 180 days; // 6 months linear vesting for rewards
    uint256 public constant UNBONDING_PERIOD = 14 days; // Constant for the unbonding period
    uint256 public constant MAX_VESTING_START_DATE_EXTENSION = 365 days; // 1 year (approx. 365 days)

    // NEW: State variable to store the base URI for NFT metadata
    string private _baseTokenURI;

    // --- Events ---
    event UnbondingPositionCreated(
        address indexed user,
        uint256 indexed tokenId,
        uint256 principalAmount,
        uint256 rewardAmount
    );
    event PrincipalClaimed(uint256 indexed tokenId, uint256 amount);
    event VestedRewardsClaimed(uint256 indexed tokenId, uint256 amount);
    event RewardVestingDateFinalized(
        uint256 indexed tokenId,
        uint256 actualVestingStartDate
    );
    event OrphanedNFTBurned(uint256 indexed tokenId, address indexed owner);
    event StakingVaultSet(address indexed vaultAddress); // NEW EVENT
    event BaseURISet(string newBaseURI); // NEW EVENT for setting base URI

    // Custom Errors
    error NFTDoesNotExist();
    error NotOwnerOfNFT();
    error UnbondingPeriodNotOver();
    error PrincipalAlreadyClaimed();
    error NoPrincipalToClaim();
    error NoRewardsAssociated();
    error RewardVestingNotStarted();
    error AllRewardsClaimed();
    error NoNewVestedRewards();
    error RewardVestingDateAlreadyFinalized();
    error NewVestingStartDateTooEarly();
    error VestingStartDateTooFarInFuture();
    error PrincipalNotClaimedYet();
    error RewardsNotFullyClaimedYet();
    error StakingVaultAlreadySet(); // NEW ERROR

    constructor(
        address _initialOwner, // The initial owner, typically the deployer. Ownership is transferred later.
        uint256 _rewardsUnlockTimestamp
    ) ERC721("ZoopX Unbonding Position", "uzTICS") Ownable(_initialOwner) {
        // FIX: The stakingVault address is no longer set in the constructor.
        rewardsUnlockTimestamp = _rewardsUnlockTimestamp;
        _nextTokenId = 0; // Initialize token ID counter
        // _baseTokenURI can be initialized here or left empty to be set by admin later
        // _baseTokenURI = "https://your-dynamic-metadata-api.com/metadata/"; // Example: uncomment and set a default
    }

    /**
     * @notice Sets the TICS_Staking_Vault address.
     * @dev Can only be called once by the owner (which will be the TICS_Staking_Vault itself after ownership transfer).
     * This function is crucial for breaking the circular deployment dependency.
     * @param _vaultAddress The address of the TICS_Staking_Vault contract.
     */
    function setStakingVault(address _vaultAddress) external onlyOwner {
        if (stakingVault != address(0)) revert StakingVaultAlreadySet();
        require(_vaultAddress != address(0), "Cannot set to zero address");
        stakingVault = _vaultAddress;
        emit StakingVaultSet(_vaultAddress);
    }

    /**
     * @notice Sets the base URI for all NFT token IDs.
     * @dev Can only be called by the contract owner (the Admin.sol contract or the TICS_Staking_Vault).
     * This URI will be prepended to the token ID to form the full tokenURI.
     * Example: "https://your-dynamic-metadata-api.com/metadata/"
     * @param baseURI_ The base URL for the NFT metadata API.
     */
    function setBaseURI(string memory baseURI_) public onlyOwner {
        _baseTokenURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    /**
     * @notice Returns the base URI for all token IDs.
     * @dev This is an internal helper function for tokenURI.
     * Overrides the default _baseURI from ERC721.
     */
    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // The tokenURI function is automatically implemented by ERC721Enumerable
    // by combining _baseURI() and Strings.toString(tokenId).
    // No explicit override is needed here unless you want custom logic beyond the default.
    // Example of what it does internally (conceptual):
    // function tokenURI(uint256 tokenId) public view override returns (string memory) {
    //     _requireOwned(tokenId);
    //     return string(abi.encodePacked(_baseURI(), Strings.toString(tokenId)));
    // }

    function createUnbondingPosition(
        address _user,
        uint256 _principalAmount,
        uint256 _rewardAmount,
        uint256 _provisionalVestingStartDate,
        bool _rewardVestingDateFinalized
    ) external onlyOwner returns (uint256 tokenId) {
        // This check will now work correctly after setStakingVault is called.
        require(msg.sender == stakingVault, "Only staking vault can call");

        tokenId = _nextTokenId++;

        unbondingPositions[tokenId] = UnbondingPosition({
            user: _user,
            principalAmount: _principalAmount,
            rewardAmount: _rewardAmount,
            unbondingStartTime: block.timestamp,
            rewardVestingStartDate: _provisionalVestingStartDate,
            rewardVestingEndDate: _provisionalVestingStartDate +
                REWARD_VESTING_DURATION,
            claimedRewards: 0,
            principalClaimed: false,
            rewardVestingDateFinalized: _rewardVestingDateFinalized
        });

        _safeMint(_user, tokenId);

        emit UnbondingPositionCreated(
            _user,
            tokenId,
            _principalAmount,
            _rewardAmount
        );
    }

    function processPrincipalClaim(
        uint256 _tokenId
    ) external onlyOwner returns (uint256 amountToClaim, bool shouldBurnNFT) {
        // FIX: Removed the incorrect check: require(ownerOf(_tokenId) == msg.sender, "Not owner of NFT");
        // The onlyOwner modifier correctly ensures only the TICS_Staking_Vault can call this.
        UnbondingPosition storage position = unbondingPositions[_tokenId];

        if (position.principalAmount == 0) revert NoPrincipalToClaim();
        if (position.principalClaimed) revert PrincipalAlreadyClaimed();
        if (block.timestamp < position.unbondingStartTime + UNBONDING_PERIOD)
            revert UnbondingPeriodNotOver();

        amountToClaim = position.principalAmount;
        position.principalAmount = 0;
        position.principalClaimed = true;

        shouldBurnNFT = (position.principalClaimed &&
            (position.rewardAmount == 0 ||
                position.claimedRewards == position.rewardAmount));
    }

    function processVestedRewardsClaim(
        uint256 _tokenId
    ) external onlyOwner returns (uint256 amountToClaim, bool shouldBurnNFT) {
        // FIX: Removed the incorrect check: require(ownerOf(_tokenId) == msg.sender, "Not owner of NFT");
        UnbondingPosition storage position = unbondingPositions[_tokenId];

        if (position.rewardAmount == 0) revert NoRewardsAssociated();
        if (block.timestamp < position.rewardVestingStartDate)
            revert RewardVestingNotStarted();
        if (position.claimedRewards == position.rewardAmount)
            revert AllRewardsClaimed();

        uint256 totalVestingDuration = position.rewardVestingEndDate -
            position.rewardVestingStartDate;
        uint256 currentClaimable;

        if (totalVestingDuration == 0) {
            currentClaimable = position.rewardAmount - position.claimedRewards;
        } else {
            uint256 elapsedVestingTime = block.timestamp -
                position.rewardVestingStartDate;
            if (elapsedVestingTime > totalVestingDuration) {
                elapsedVestingTime = totalVestingDuration;
            }
            uint256 totalVested = (position.rewardAmount * elapsedVestingTime) /
                totalVestingDuration;
            currentClaimable = totalVested - position.claimedRewards;
        }

        if (currentClaimable == 0) revert NoNewVestedRewards();

        amountToClaim = currentClaimable;
        position.claimedRewards += amountToClaim;

        shouldBurnNFT = (position.principalClaimed &&
            position.claimedRewards == position.rewardAmount);
    }

    function burnNFT(uint256 _tokenId) external onlyOwner {
        UnbondingPosition storage position = unbondingPositions[_tokenId];

        if (!position.principalClaimed) revert PrincipalNotClaimedYet();
        if (
            position.rewardAmount > 0 &&
            position.claimedRewards < position.rewardAmount
        ) revert RewardsNotFullyClaimedYet();

        address nftOwner = ownerOf(_tokenId);
        _burn(_tokenId);
        delete unbondingPositions[_tokenId];
        emit OrphanedNFTBurned(_tokenId, nftOwner);
    }

    function adminBurnOrphanedNFT(uint256 _tokenId) external onlyOwner {
        this.burnNFT(_tokenId);
    }

    function finalizeRewardVestingDate(
        uint256 _tokenId,
        uint256 _actualVestingStartDate
    ) external onlyOwner {
        ownerOf(_tokenId); // Existence check

        UnbondingPosition storage request = unbondingPositions[_tokenId];

        if (request.rewardAmount == 0) revert NoRewardsAssociated();
        if (request.rewardVestingDateFinalized)
            revert RewardVestingDateAlreadyFinalized();
        if (_actualVestingStartDate < request.rewardVestingStartDate)
            revert NewVestingStartDateTooEarly();
        if (
            _actualVestingStartDate >
            block.timestamp + MAX_VESTING_START_DATE_EXTENSION
        ) revert VestingStartDateTooFarInFuture();

        request.rewardVestingStartDate = _actualVestingStartDate;
        request.rewardVestingEndDate =
            _actualVestingStartDate +
            REWARD_VESTING_DURATION;
        request.rewardVestingDateFinalized = true;

        emit RewardVestingDateFinalized(_tokenId, _actualVestingStartDate);
    }

    // --- View Functions ---

    function getUnbondingPosition(
        uint256 _tokenId
    )
        public
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
        )
    {
        UnbondingPosition storage position = unbondingPositions[_tokenId];
        return (
            position.user,
            position.principalAmount,
            position.rewardAmount,
            position.unbondingStartTime,
            position.rewardVestingStartDate,
            position.rewardVestingEndDate,
            position.claimedRewards,
            position.principalClaimed,
            position.rewardVestingDateFinalized
        );
    }

    function getClaimableVestedRewards(
        uint256 _tokenId
    ) public view returns (uint256 claimable) {
        UnbondingPosition storage position = unbondingPositions[_tokenId];
        if (
            position.rewardAmount == 0 ||
            block.timestamp < position.rewardVestingStartDate ||
            position.claimedRewards == position.rewardAmount
        ) {
            return 0;
        }

        uint256 totalVestingDuration = position.rewardVestingEndDate -
            position.rewardVestingStartDate;

        if (totalVestingDuration == 0) {
            claimable = position.rewardAmount - position.claimedRewards;
        } else {
            uint256 elapsedVestingTime = block.timestamp -
                position.rewardVestingStartDate;
            if (elapsedVestingTime > totalVestingDuration) {
                elapsedVestingTime = totalVestingDuration;
            }
            uint256 totalVested = (position.rewardAmount * elapsedVestingTime) /
                totalVestingDuration;
            claimable = totalVested - position.claimedRewards;
        }
        return claimable;
    }
}
