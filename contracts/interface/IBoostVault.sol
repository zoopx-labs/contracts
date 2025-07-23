// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ZoopX IBoostVault Contract
/// @notice Interface for the BoostVault, managing zTICS staking and point distribution.
interface IBoostVault {
    /// @notice Represents a user's staked zTICS amount and accumulated reward debt for point calculation.
    struct UserBoostInfo {
        uint256 amount; // Amount of zTICS staked by the user.
        uint256 rewardDebt; // Points owed to the user, used for accurate point calculation.
    }

    /// @notice Stakes a specified amount of zTICS for a user.
    /// @param _user The address of the user staking zTICS.
    /// @param _amount The amount of zTICS to stake.
    function stakeZtics(address _user, uint256 _amount) external;

    /// @notice Unstakes a specified amount of zTICS for a user.
    /// @param _user The address of the user unstaking zTICS.
    /// @param _amount The amount of zTICS to unstake.
    function unstakeZtics(address _user, uint256 _amount) external;

    /// @notice Allows a user to claim their accumulated points.
    /// @param _user The address of the user claiming points.
    function claimPoints(address _user) external;

    /// @notice Retrieves the number of pending points for a given user.
    /// @param _user The address of the user to query.
    /// @return The amount of points currently pending for the user.
    function pendingPoints(address _user) external view returns (uint256);

    /// @notice Retrieves the staked zTICS amount and pending points for a specific user.
    /// @param _user The address of the user to query.
    /// @return stakedZtics The total amount of zTICS staked by the user.
    /// @return _pendingPoints The total points pending for the user.
    function getUserBoostInfo(
        address _user
    ) external view returns (uint256 stakedZtics, uint256 _pendingPoints);

    /// @notice Retrieves the total amount of zTICS staked across all users in the BoostVault.
    /// @return The total amount of zTICS staked in the BoostVault.
    function totalBoostVaultStaked() external view returns (uint256);

    /// @notice Checks if the BoostVault is currently paused.
    /// @return True if the BoostVault is paused, false otherwise.
    function isBoostVaultPaused() external view returns (bool);

    /// @notice Retrieves the current rate at which points are generated per second.
    /// @return The points generated per second.
    function pointsPerSecond() external view returns (uint256);

    /// @notice Sets a new rate for points generated per second.
    /// @param _newRate The new rate for points per second.
    function setPointsPerSecond(uint256 _newRate) external;

    /// @notice Pauses or unpauses the BoostVault's operations.
    /// @param _paused A boolean indicating whether to pause (true) or unpause (false) the vault.
    function setBoostVaultPause(bool _paused) external;
}
