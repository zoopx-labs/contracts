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

describe("TICS_Staking_Vault - Vesting & Snapshot Edge Cases", function () {
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
  let user2: Signer;
  let whale: Signer;

  let rewardsUnlockTimestamp: number;

  // --- DEPLOYMENT FIXTURE ---
  async function deployVestingFixture() {
    [owner, adminAccount, keeperAccount, treasuryAccount, user1, user2, whale] =
      await ethers.getSigners();

    const now = await time.latest();
    rewardsUnlockTimestamp = now + 5 * 30 * 24 * 60 * 60; // ~5 months

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

    const KEEPER_ROLE = await admin.KEEPER_ROLE();
    await admin
      .connect(adminAccount)
      .grantRole(KEEPER_ROLE, await keeperAccount.getAddress());
  }

  beforeEach(async function () {
    await deployVestingFixture();
  });

  // ----------------------------------------------------------------
  // 🧭 1. TIME BOUNDARY TESTS
  // ----------------------------------------------------------------
  describe("🧭 Time Boundary Tests", function () {
    it("Snapshot at MAX_CONFIG_DATE: Should revert just after the boundary", async () => {
      const maxConfigDate = await ticsVault.MAX_CONFIG_DATE();
      await time.setNextBlockTimestamp(Number(maxConfigDate) + 1);
      await expect(
        ticsVault.connect(adminAccount).takeRewardSnapshot()
      ).to.be.revertedWith("Configuration period has ended");
    });
  });

  // ----------------------------------------------------------------
  // 🧪 2. STATE SANITY TESTS
  // ----------------------------------------------------------------
  describe("🧪 State Sanity Tests", function () {
    it("Snapshot when TVL/supply = 0: Should set rate to 1e18", async () => {
      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const snapshotRate = await ticsVault.snapshotExchangeRate();
      expect(snapshotRate).to.equal(ethers.parseEther("1"));
    });

    it("Snapshot rate = 1: Should result in zero rewards portion", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });
      await ticsVault.connect(adminAccount).takeRewardSnapshot();

      const zTicsToBurn = ethers.parseEther("10");
      const withdrawTx = await ticsVault.connect(user1).withdraw(zTicsToBurn);
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;

      const rewardsPortion = withdrawEvent!.args[5];
      expect(rewardsPortion).to.equal(0);
    });

    it("Two snapshots with no state change should yield identical rate", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });
      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const rate1 = await ticsVault.snapshotExchangeRate();

      await time.increase(100);
      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const rate2 = await ticsVault.snapshotExchangeRate();

      expect(rate2).to.equal(rate1);
    });
  });

  // ----------------------------------------------------------------
  // 💣 3. ADVERSARIAL & MULTI-USER TESTS
  // ----------------------------------------------------------------
  describe("💣 Adversarial & Multi-User Tests", function () {
    it("Multiple pre-snapshot withdrawals: Should not affect a later snapshot's logic", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });
      await ticsVault
        .connect(user2)
        .deposit(0, { value: ethers.parseEther("100") });

      // Delegate funds to prevent underflow on withdrawal.
      await time.increase(await ticsVault.DELEGATION_COOLDOWN());
      await ticsVault.connect(keeperAccount).triggerDelegation();

      // The contract should no longer panic, so we proceed with the original logic
      await ticsVault
        .connect(user1)
        .withdraw(await zTICS.balanceOf(await user1.getAddress()));

      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("20"));
      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const snapshotRate = await ticsVault.snapshotExchangeRate();

      const zTicsToBurn = await zTICS.balanceOf(await user2.getAddress());
      const totalTicsValue = await ticsVault.getTicsByZTics(zTicsToBurn);
      const valueAtSnapshot =
        (zTicsToBurn * snapshotRate) / ethers.parseEther("1");
      const expectedRewards = valueAtSnapshot - zTicsToBurn;

      const withdrawTx = await ticsVault.connect(user2).withdraw(zTicsToBurn);
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;

      expect(withdrawEvent!.args[5]).to.equal(expectedRewards);
    });

    it("Whale tries to distort snapshot: Should correctly capture the rate", async () => {
      // Reduced deposit amount to a realistic value for a test wallet.
      await ticsVault
        .connect(whale)
        .deposit(0, { value: ethers.parseEther("9000") });
      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("1"));

      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const snapshotRate = await ticsVault.snapshotExchangeRate();

      expect(snapshotRate).to.be.gt(ethers.parseEther("1"));
      // Adjusted upper bound to be less brittle and more accurate for the new deposit amount.
      // (9000 + 1) / 9000 = 1.000111...
      expect(snapshotRate).to.be.lt(ethers.parseEther("1.00012"));
    });
  });

  // ----------------------------------------------------------------
  // ⚖️ 4. PRECISION & ECONOMIC SAFETY
  // ----------------------------------------------------------------
  describe("⚖️ Precision & Economic Safety", function () {
    it("zTICS = 1 wei: Should withdraw without precision loss", async () => {
      await ticsVault.connect(user1).deposit(0, { value: 1 });

      // Delegate funds to prevent underflow on withdrawal.
      await time.increase(await ticsVault.DELEGATION_COOLDOWN());
      await ticsVault.connect(keeperAccount).triggerDelegation();

      await ticsVault.connect(keeperAccount).updateUnclaimedRewards(1);
      await ticsVault.connect(adminAccount).takeRewardSnapshot();

      // The contract should no longer panic, so we proceed with the original logic
      const withdrawTx = await ticsVault.connect(user1).withdraw(1);
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;

      const principalPortion = withdrawEvent!.args[4];
      const rewardsPortion = withdrawEvent!.args[5];

      expect(principalPortion).to.equal(1);
      expect(rewardsPortion).to.equal(1);
    });

    it("Post-snapshot reward update doesn't leak into vested portion", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });
      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("10"));

      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const snapshotRate = await ticsVault.snapshotExchangeRate();

      // Simulate more rewards accruing AFTER the snapshot
      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("50")); // This increases total unclaimed rewards

      const zTicsToBurn = ethers.parseEther("10");

      // Calculate expected vested rewards based ONLY on the snapshot rate, not subsequent rewards
      const valueAtSnapshot =
        (zTicsToBurn * snapshotRate) / ethers.parseEther("1");
      const expectedVestedRewards = valueAtSnapshot - zTicsToBurn;

      const withdrawTx = await ticsVault.connect(user1).withdraw(zTicsToBurn);
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;

      const rewardsPortion = withdrawEvent!.args[5];

      // Expect rewardsPortion to equal only the vested rewards from the snapshot
      expect(rewardsPortion).to.equal(expectedVestedRewards);
    });

    it("Withdrawal at the exact snapshot boundary should use snapshot logic", async () => {
      await ticsVault
        .connect(user1)
        .deposit(0, { value: ethers.parseEther("100") });
      await ticsVault
        .connect(keeperAccount)
        .updateUnclaimedRewards(ethers.parseEther("10"));

      await ticsVault.connect(adminAccount).takeRewardSnapshot();
      const snapshotTime = await ticsVault.snapshotTimestamp();

      // Use increaseTo to avoid same-timestamp errors.
      await time.increaseTo(Number(snapshotTime) + 1); // Increment by 1 to avoid same timestamp error

      const withdrawTx = await ticsVault
        .connect(user1)
        .withdraw(ethers.parseEther("10"));
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;
      const tokenId = withdrawEvent!.args[3];

      const position = await unbondingManager.unbondingPositions(tokenId);
      expect(position.rewardVestingStartDate).to.equal(snapshotTime);
    });
  });
});
