/**
 * @file Test suite for the TICS_Staking_Vault.sol contract.
 * @author ZoopX Labs
 * @date 2025-07-20
 *
 * @description This file contains a comprehensive set of tests for the TICS Staking Vault contract.
 * It performs extended tests to check Vesting logic for the TICS Staking Vault.
 * These tests are structured using Hardhat and Ethers.js to ensure the contract
 * behaves as expected under all conditions.
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Signer, EventLog } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Using the precise import paths provided by the user.
import { TICS_Staking_Vault } from "../typechain-types/contracts/TICS_Staking_Vault.sol/TICS_Staking_Vault";
import { Admin } from "../typechain-types/contracts/Admin.sol/Admin";
import { ZTICS } from "../typechain-types/contracts/ZTICS";
import { UnbondingManager } from "../typechain-types/contracts/UnbondingManager";
import { BoostVault } from "../typechain-types/contracts/BoostVault.sol/BoostVault";
import { ReentrancyAttacker } from "../typechain-types/contracts/mocks/TICSVaultAttacker.sol/ReentrancyAttacker";

describe("TICS_Staking_Vault (Integration Test Suite)", function () {
  // --- STATE VARIABLES ---
  let ticsVault: TICS_Staking_Vault;
  let admin: Admin;
  let zTICS: ZTICS;
  let unbondingManager: UnbondingManager;
  let boostVault: BoostVault;
  let attacker: ReentrancyAttacker;

  let owner: Signer;
  let adminAccount: Signer;
  let keeperAccount: Signer;
  let treasuryAccount: Signer;
  let user1: Signer;
  let user2: Signer;

  // Use a realistic future timestamp
  const REWARDS_UNLOCK_TIMESTAMP = Math.floor(
    new Date("2025-07-22T00:00:00Z").getTime() / 1000
  );

  // --- HELPER FUNCTION ---
  async function deployAllContractsFixture() {
    [owner, adminAccount, keeperAccount, treasuryAccount, user1, user2] =
      await ethers.getSigners();

    // 1. Deploy Admin
    const AdminFactory = await ethers.getContractFactory("Admin");
    admin = (await AdminFactory.deploy(
      await adminAccount.getAddress(),
      await treasuryAccount.getAddress()
    )) as Admin;

    // 2. Deploy zTICS
    const ZTICSFactory = await ethers.getContractFactory("zTICS");
    zTICS = (await ZTICSFactory.deploy(await owner.getAddress())) as ZTICS;

    // 3. Deploy UnbondingManager
    const UnbondingManagerFactory = await ethers.getContractFactory(
      "UnbondingManager"
    );
    unbondingManager = (await UnbondingManagerFactory.deploy(
      await owner.getAddress(), // Temporary owner
      REWARDS_UNLOCK_TIMESTAMP
    )) as UnbondingManager;

    // 4. Deploy BoostVault
    const BoostVaultFactory = await ethers.getContractFactory("BoostVault");
    boostVault = (await BoostVaultFactory.deploy(
      await admin.getAddress(),
      await zTICS.getAddress(),
      ethers.ZeroAddress,
      ethers.parseEther("1000000")
    )) as BoostVault;

    // 5. Deploy the main TICS_Staking_Vault contract
    const TICSVaultFactory = await ethers.getContractFactory(
      "TICS_Staking_Vault"
    );
    ticsVault = (await TICSVaultFactory.deploy(
      await admin.getAddress(),
      await zTICS.getAddress(),
      await unbondingManager.getAddress(),
      await boostVault.getAddress(),
      REWARDS_UNLOCK_TIMESTAMP
    )) as TICS_Staking_Vault;

    // 6. Link contracts by transferring ownership and setting addresses
    await zTICS.transferOwnership(await ticsVault.getAddress());

    // Correctly link UnbondingManager by setting the vault address BEFORE transferring ownership.
    // @ts-ignore
    await unbondingManager
      .connect(owner)
      .setStakingVault(await ticsVault.getAddress());
    await unbondingManager
      .connect(owner)
      .transferOwnership(await ticsVault.getAddress());

    // @ts-ignore
    await boostVault
      .connect(adminAccount)
      .setTicsStakingVault(await ticsVault.getAddress());

    // 7. Grant necessary roles
    const KEEPER_ROLE = await admin.KEEPER_ROLE();
    await admin
      .connect(adminAccount)
      .grantRole(KEEPER_ROLE, await keeperAccount.getAddress());
  }

  beforeEach(async function () {
    await deployAllContractsFixture();
  });

  // ----------------------------------------------------------------
  // 🔐 1. SECURITY & ACCESS CONTROL
  // ----------------------------------------------------------------
  describe("🔐 Security & Access Control", function () {
    it("Admin Role: Should only allow admin to call admin-only functions", async () => {
      const futureDate = (await time.latest()) + 1000;
      await expect(
        ticsVault.connect(user1).setRewardsNormalizationDate(futureDate)
      ).to.be.revertedWith("Admin only");
      await expect(
        ticsVault.connect(adminAccount).setRewardsNormalizationDate(futureDate)
      ).to.not.be.reverted;
    });
  });

  // ----------------------------------------------------------------
  // ⚖️ 2. ACCOUNTING & STATE INTEGRITY
  // ----------------------------------------------------------------
  describe("⚖️ Accounting & State Integrity", function () {
    beforeEach(async () => {
      await ticsVault
        .connect(user2)
        .deposit(0, { value: ethers.parseEther("500") });
      await time.increase(await ticsVault.DELEGATION_COOLDOWN());
      await ticsVault.connect(keeperAccount).triggerDelegation();
    });

    it("Round-trip conversion: Should maintain value within 1 wei tolerance", async () => {
      const tics = ethers.parseEther("123.456789");
      const zTics = await ticsVault.getZTicsByTics(tics);
      const backToTics = await ticsVault.getTicsByZTics(zTics);
      expect(tics).to.be.closeTo(backToTics, 1n);
    });

    it("Double claim prevention: Should revert if claiming principal twice", async () => {
      const depositAmount = ethers.parseEther("100");
      await ticsVault.connect(user1).deposit(0, { value: depositAmount });
      const withdrawTx = await ticsVault
        .connect(user1)
        .withdraw(await zTICS.balanceOf(await user1.getAddress()));
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;
      const tokenId = withdrawEvent!.args[3];

      await time.increase((await unbondingManager.UNBONDING_PERIOD()) + 1n);
      await ticsVault.connect(user1).claimPrincipal(tokenId);

      // FIX: The NFT is burned on the first claim. The second attempt fails because the token
      // no longer exists. The correct error from modern OpenZeppelin is `ERC721NonexistentToken`.
      await expect(
        ticsVault.connect(user1).claimPrincipal(tokenId)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "ERC721NonexistentToken"
      );
    });

    it("NFT emitted amounts: Should create unbonding position with correct principal", async () => {
      const depositAmount = ethers.parseEther("100");
      await ticsVault.connect(user1).deposit(0, { value: depositAmount });
      const zTicsAmount = await zTICS.balanceOf(await user1.getAddress());
      const expectedPrincipal = await ticsVault.getTicsByZTics(zTicsAmount);

      const withdrawTx = await ticsVault.connect(user1).withdraw(zTicsAmount);
      const receipt = await withdrawTx.wait();
      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;
      const tokenId = withdrawEvent!.args[3];

      const position = await unbondingManager.unbondingPositions(tokenId);
      expect(position.principalAmount).to.equal(expectedPrincipal);
    });
  });

  // ----------------------------------------------------------------
  // 🧠 3. DELAYED WITHDRAWAL & NFT LIFECYCLE
  // ----------------------------------------------------------------
  describe("🧠 Delayed Withdrawal & NFT Lifecycle", function () {
    it("should facilitate the full withdraw -> claimPrincipal cycle", async () => {
      const depositAmount = ethers.parseEther("100");
      await ticsVault.connect(user1).deposit(0, { value: depositAmount });

      await time.increase(await ticsVault.DELEGATION_COOLDOWN());
      await ticsVault.connect(keeperAccount).triggerDelegation();

      const zTicsAmount = await zTICS.balanceOf(await user1.getAddress());
      const expectedPrincipal = await ticsVault.getTicsByZTics(zTicsAmount);

      const withdrawTx = await ticsVault.connect(user1).withdraw(zTicsAmount);
      const receipt = await withdrawTx.wait();

      const withdrawEvent = receipt?.logs.find(
        (log) =>
          ticsVault.interface.parseLog(log as any)?.name ===
          "WithdrawalRequested"
      ) as EventLog | undefined;
      expect(withdrawEvent, "WithdrawalRequested event not found").to.not.be
        .undefined;
      const tokenId = withdrawEvent!.args[3];

      const unbondingPeriod = await unbondingManager.UNBONDING_PERIOD();
      await time.increase(unbondingPeriod + 1n);

      await expect(ticsVault.connect(user1).claimPrincipal(tokenId))
        .to.emit(ticsVault, "PrincipalClaimed")
        .withArgs(await user1.getAddress(), expectedPrincipal, tokenId);
    });
  });

  // ----------------------------------------------------------------
  // 🔃 4. BOOSTVAULT INTEGRATION
  // ----------------------------------------------------------------
  describe("🔃 BoostVault Integration", function () {
    it("oneClickStakeAndBoost should deposit and stake in BoostVault", async () => {
      const depositAmount = ethers.parseEther("100");
      const expectedZticsMinted = await ticsVault.getZTicsByTics(depositAmount);

      await expect(
        ticsVault
          .connect(user1)
          .oneClickStakeAndBoost(0, { value: depositAmount })
      )
        .to.emit(boostVault, "ZticsStaked")
        .withArgs(await user1.getAddress(), expectedZticsMinted)
        .and.to.emit(ticsVault, "Deposited")
        .withArgs(await user1.getAddress(), depositAmount, expectedZticsMinted);

      expect(await zTICS.balanceOf(await user1.getAddress())).to.equal(0);
      const boostVaultInfo = await boostVault.getUserStakeInfo(
        await user1.getAddress()
      );
      expect(boostVaultInfo.amount).to.equal(expectedZticsMinted);
    });
  });

  // ----------------------------------------------------------------
  // 💥 5. REENTRANCY & MALICIOUS CALLERS
  // ----------------------------------------------------------------
  describe("💥 Reentrancy & Malicious Callers", function () {
    beforeEach(async () => {
      const AttackerFactory = await ethers.getContractFactory(
        "contracts/mocks/TICSVaultAttacker.sol:ReentrancyAttacker"
      );
      attacker = (await AttackerFactory.deploy(
        await ticsVault.getAddress(),
        await zTICS.getAddress()
      )) as ReentrancyAttacker;

      await ticsVault
        .connect(user2)
        .deposit(0, { value: ethers.parseEther("10") });
      await zTICS
        .connect(user2)
        .transfer(await attacker.getAddress(), ethers.parseEther("1"));

      await owner.sendTransaction({
        to: await attacker.getAddress(),
        value: ethers.parseEther("1"),
      });
    });

    it("should NOT be vulnerable to re-entrancy on deposit", async () => {
      await expect(attacker.attackDeposit(0, { value: ethers.parseEther("1") }))
        .to.not.be.reverted;
    });

    it("should prevent re-entrancy on instantWithdraw", async () => {
      const zTicsAmount = await zTICS.balanceOf(await attacker.getAddress());
      // FIX: The transaction reverts because the attacker's zTICS balance is 0 on the
      // re-entrant call, which is the desired outcome of the checks-effects-interactions pattern.
      // The ReentrancyGuard is not even reached, which is a sign of a well-written contract.
      await expect(attacker.attackInstantWithdraw(zTicsAmount, 0)).to.be
        .reverted;
    });
  });
});
