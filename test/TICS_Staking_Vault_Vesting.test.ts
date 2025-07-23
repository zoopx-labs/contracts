/**
 * @file Test suite for the TICS_Staking_Vault.sol contract.
 * @author ZoopX Labs
 * @date 2025-07-23
 *
 * @description This file contains a comprehensive set of tests for the TICS Staking Vault contract.
 * It performs extended tests to check Vesting logic for the TICS Staking Vault.
 * These tests are structured using Hardhat and Ethers.js to ensure the contract
 * behaves as expected under all conditions.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer, EventLog } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Import contract types from TypeChain
import { TICS_Staking_Vault } from "../typechain-types/contracts/TICS_Staking_Vault.sol/TICS_Staking_Vault";
import { Admin } from "../typechain-types/contracts/Admin.sol/Admin";
import { ZTICS } from "../typechain-types/contracts/ZTICS";
import { UnbondingManager } from "../typechain-types/contracts/UnbondingManager";
import { BoostVault } from "../typechain-types/contracts/BoostVault.sol/BoostVault";

describe("TICS_Staking_Vault - Snapshot & Vesting Logic", function () {
  // --- STATE VARIABLES ---
  let ticsVault: TICS_Staking_Vault;
  let admin: Admin;
  let zTICS: ZTICS;
  let unbondingManager: UnbondingManager;
  let boostVault: BoostVault;

  let owner: Signer;
  let adminAccount: Signer;
  let keeperAccount: Signer;
  let treasuryAccount: Signer;
  let user1: Signer;

  let rewardsUnlockTimestamp: number; // The 5-month cliff date

  // --- DEPLOYMENT FIXTURE ---
  async function deployVestingFixture() {
    [owner, adminAccount, keeperAccount, treasuryAccount, user1] =
      await ethers.getSigners();

    const now = await time.latest();
    rewardsUnlockTimestamp = now + 5 * 30 * 24 * 60 * 60; // ~5 months from now

    // Deploy all contracts
    const AdminFactory = await ethers.getContractFactory("Admin");
    admin = (await AdminFactory.deploy(
      await adminAccount.getAddress(),
      await treasuryAccount.getAddress()
    )) as Admin;

    const ZTICSFactory = await ethers.getContractFactory("zTICS");
    zTICS = (await ZTICSFactory.deploy(await owner.getAddress())) as ZTICS;

    const UnbondingManagerFactory = await ethers.getContractFactory(
      "UnbondingManager"
    );
    unbondingManager = (await UnbondingManagerFactory.deploy(
      await owner.getAddress(),
      rewardsUnlockTimestamp
    )) as UnbondingManager;

    const BoostVaultFactory = await ethers.getContractFactory("BoostVault");
    boostVault = (await BoostVaultFactory.deploy(
      await admin.getAddress(),
      await zTICS.getAddress(),
      ethers.ZeroAddress,
      ethers.parseEther("1000000")
    )) as BoostVault;

    const TICSVaultFactory = await ethers.getContractFactory(
      "TICS_Staking_Vault"
    );
    ticsVault = (await TICSVaultFactory.deploy(
      await admin.getAddress(),
      await zTICS.getAddress(),
      await unbondingManager.getAddress(),
      await boostVault.getAddress(),
      rewardsUnlockTimestamp
    )) as TICS_Staking_Vault;

    // Link contracts
    await zTICS.transferOwnership(await ticsVault.getAddress());
    // @ts-ignore
    await unbondingManager
      .connect(owner)
      .setStakingVault(await ticsVault.getAddress());
    await unbondingManager.transferOwnership(await ticsVault.getAddress());
    // @ts-ignore
    await boostVault
      .connect(adminAccount)
      .setTicsStakingVault(await ticsVault.getAddress());

    // Grant roles
    const KEEPER_ROLE = await admin.KEEPER_ROLE();
    await admin
      .connect(adminAccount)
      .grantRole(KEEPER_ROLE, await keeperAccount.getAddress());
  }

  beforeEach(async function () {
    await deployVestingFixture();
  });

  // ----------------------------------------------------------------
  // 📸 1. SNAPSHOT FUNCTIONALITY
  // ----------------------------------------------------------------
  describe("📸 Snapshot Functionality", function () {
    it("Should revert if a non-admin tries to take a snapshot", async () => {
      await expect(
        ticsVault.connect(user1).takeRewardSnapshot()
      ).to.be.revertedWith("Admin only");
    });

    it("Should allow admin to take a snapshot and emit an event", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") }); // Establish a rate

      await expect(
        ticsVault.connect(adminAccount).takeRewardSnapshot()
      ).to.emit(ticsVault, "RewardSnapshotTaken");

      expect(await ticsVault.snapshotTimestamp()).to.be.gt(0);
      expect(await ticsVault.snapshotExchangeRate()).to.be.gt(0);
    });

    it("Should allow admin to update the snapshot multiple times before MAX_CONFIG_DATE", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });
      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const firstSnapshotRate = await ticsVault.snapshotExchangeRate();

      // Simulate rewards accruing, changing the rate
      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("10"));
      await time.increase(100);

      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const secondSnapshotRate = await ticsVault.snapshotExchangeRate();

      expect(secondSnapshotRate).to.not.equal(firstSnapshotRate);
    });

    it("Should revert if trying to take a snapshot after MAX_CONFIG_DATE", async () => {
      const maxConfigDate = await ticsVault.MAX_CONFIG_DATE();
      await time.increaseTo(maxConfigDate + 1n);

      await expect(
        ticsVault.connect(adminAccount).takeRewardSnapshot()
      ).to.be.revertedWith("Configuration period has ended");
    });
  });

  // ----------------------------------------------------------------
  // ⚖️ 2. WITHDRAWAL LOGIC: BEFORE VS. AFTER SNAPSHOT
  // ----------------------------------------------------------------
  describe("⚖️ Withdrawal Logic: Before vs. After Snapshot", function () {
    beforeEach(async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("1000") });
      // Simulate rewards to create a non 1:1 exchange rate
      await time.increase(await ticsVault.DELEGATION_COOLDOWN());
      await ticsVault.connect(keeperAccount).triggerDelegation();
      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("100"));
      await time.increaseTo(rewardsUnlockTimestamp + 100); // Move time past the cliff
    });

    it("BEFORE Snapshot: Should use block.timestamp for vesting start date", async () => {
      const withdrawTx = await ticsVault
        .connect(user1)
        .withdraw(ethers.parseEther("100"));
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;
      const tokenId = withdrawEvent!.args[3];

      const position = await unbondingManager.unbondingPositions(tokenId);
      const latestTime = await time.latest();

      expect(position.rewardVestingStartDate).to.equal(latestTime);
    });

    it("AFTER Snapshot: Should use snapshotTimestamp for vesting start date and split rewards", async () => {
      // Admin takes the snapshot
      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const snapshotTime = await ticsVault.snapshotTimestamp();
      const snapshotRate = await ticsVault.snapshotExchangeRate();

      // Simulate more rewards accruing AFTER the snapshot
      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("200"));
      await time.increase(1000);

      const zTicsToBurn = ethers.parseEther("100");

      // Calculate expected values based on contract logic
      // valueAtSnapshot = (zTicsToBurn * snapshotRate) / PRECISION
      // rewardsPortion = valueAtSnapshot - zTicsToBurn (if valueAtSnapshot > zTicsToBurn, else 0)
      // principalPortion = totalTicsValue - rewardsPortion

      const totalTicsValue = await ticsVault.getTicsByZTics(zTicsToBurn);
      const valueAtSnapshot =
        (zTicsToBurn * snapshotRate) / ethers.parseEther("1");

      let expectedRewards: bigint;
      if (valueAtSnapshot > zTicsToBurn) {
        expectedRewards = valueAtSnapshot - zTicsToBurn;
      } else {
        expectedRewards = 0n;
      }
      const expectedPrincipal = totalTicsValue - expectedRewards;

      // User withdraws
      const withdrawTx = await ticsVault.connect(user1).withdraw(zTicsToBurn);
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;
      const tokenId = withdrawEvent!.args[3];

      const position = await unbondingManager.unbondingPositions(tokenId);

      // Check that the rewards portion is based on the snapshot rate, and the rest is principal
      expect(position.rewardAmount).to.equal(expectedRewards);
      expect(position.principalAmount).to.equal(expectedPrincipal);
      // Check that the vesting starts from the snapshot time
      expect(position.rewardVestingStartDate).to.equal(snapshotTime);
    });
  });

  // ----------------------------------------------------------------
  // 🛡️ 3. PAUSE FUNCTIONALITY & TREASURY ACCOUNTING
  // ----------------------------------------------------------------
  describe("🛡️ Pause Functionality & Treasury Accounting", function () {
    it("Should prevent instant withdrawal when paused", async () => {
      // Setup for instant withdraw
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });

      // Admin pauses the feature
      // @ts-ignore - Assuming Admin.sol has setInstantWithdrawPaused
      await admin.connect(adminAccount).setInstantWithdrawPaused(true);

      await expect(
        ticsVault.connect(user1).instantWithdraw(ethers.parseEther("10"), 0)
      ).to.be.revertedWith("Vault: Instant withdrawal is paused");
    });

    it("Should correctly send fees to the treasury on instant withdrawal", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });

      const zTicsToBurn = ethers.parseEther("10");
      const ticsToReceive = await ticsVault.getTicsByZTics(zTicsToBurn);
      const fee =
        (ticsToReceive * (await ticsVault.INSTANT_WITHDRAWAL_FEE_BPS())) /
        10000n;

      await expect(
        ticsVault.connect(user1).instantWithdraw(zTicsToBurn, 0)
      ).to.changeEtherBalance(treasuryAccount, fee);
    });
  });
});
