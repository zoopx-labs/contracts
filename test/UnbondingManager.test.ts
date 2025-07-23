import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer, EventLog } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Import contract types from TypeChain
import { UnbondingManager } from "../typechain-types/contracts/UnbondingManager";

describe("UnbondingManager (Paranoia-Grade Test Suite)", function () {
  // --- STATE VARIABLES ---
  let unbondingManager: UnbondingManager;
  let owner: Signer; // Simulates the TICS_Staking_Vault
  let user1: Signer;
  let user2: Signer;
  let nonOwner: Signer;

  const REWARDS_UNLOCK_TIMESTAMP = Math.floor(
    new Date("2025-01-01T00:00:00Z").getTime() / 1000
  );
  const VESTING_DURATION = 180 * 24 * 60 * 60; // 180 days in seconds
  const UNBONDING_PERIOD = 14 * 24 * 60 * 60; // 14 days in seconds

  // --- DEPLOYMENT FIXTURE ---
  async function deployUnbondingManagerFixture() {
    [owner, user1, user2, nonOwner] = await ethers.getSigners();

    const UnbondingManagerFactory = await ethers.getContractFactory(
      "UnbondingManager"
    );
    unbondingManager = (await UnbondingManagerFactory.deploy(
      await owner.getAddress(),
      REWARDS_UNLOCK_TIMESTAMP
    )) as UnbondingManager;

    // In the real system, the TICS_Staking_Vault would be the owner.
    // For this test, the `owner` signer simulates the vault.
    // We'll also set the stakingVault address variable for the internal check.
    // @ts-ignore
    await unbondingManager
      .connect(owner)
      .setStakingVault(await owner.getAddress());
  }

  beforeEach(async function () {
    await deployUnbondingManagerFixture();
  });

  // ----------------------------------------------------------------
  // 📝 1. POSITION CREATION & INITIALIZATION
  // ----------------------------------------------------------------
  describe("📝 Position Creation & Initialization", function () {
    it("Should deploy with correct initial state", async () => {
      expect(await unbondingManager.owner()).to.equal(await owner.getAddress());
      expect(await unbondingManager.stakingVault()).to.equal(
        await owner.getAddress()
      );
      expect(await unbondingManager.totalSupply()).to.equal(0);
    });

    it("Should allow the owner (vault) to create an unbonding position", async () => {
      const principal = ethers.parseEther("100");
      const reward = ethers.parseEther("10");

      await expect(
        unbondingManager
          .connect(owner)
          .createUnbondingPosition(
            await user1.getAddress(),
            principal,
            reward,
            REWARDS_UNLOCK_TIMESTAMP,
            false
          )
      )
        .to.emit(unbondingManager, "UnbondingPositionCreated")
        .withArgs(await user1.getAddress(), 0, principal, reward);

      const position = await unbondingManager.unbondingPositions(0);
      expect(position.user).to.equal(await user1.getAddress());
      expect(position.principalAmount).to.equal(principal);
      expect(position.rewardAmount).to.equal(reward);
      expect(await unbondingManager.ownerOf(0)).to.equal(
        await user1.getAddress()
      );
    });

    it("Should revert if a non-owner tries to create a position", async () => {
      await expect(
        unbondingManager
          .connect(nonOwner)
          .createUnbondingPosition(
            await user1.getAddress(),
            ethers.parseEther("100"),
            ethers.parseEther("10"),
            REWARDS_UNLOCK_TIMESTAMP,
            false
          )
      ).to.be.revertedWithCustomError(
        // Changed to expect custom error
        unbondingManager,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ----------------------------------------------------------------
  // 🛡️ 2. ACCESS CONTROL & ROLE RESTRICTIONS
  // ----------------------------------------------------------------
  describe("🛡️ Access Control & Role Restrictions", function () {
    it("Should revert if non-owner calls processPrincipalClaim, processVestedRewardsClaim, or burnNFT", async () => {
      await unbondingManager
        .connect(owner)
        .createUnbondingPosition(await user1.getAddress(), 1, 0, 0, true);
      const tokenId = 0;

      await expect(
        unbondingManager.connect(nonOwner).processPrincipalClaim(tokenId)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        unbondingManager.connect(nonOwner).processVestedRewardsClaim(tokenId)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        unbondingManager.connect(nonOwner).burnNFT(tokenId)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "OwnableUnauthorizedAccount"
      );
    });

    it("Should revert if setStakingVault is called twice", async () => {
      await expect(
        unbondingManager
          .connect(owner)
          .setStakingVault(await user1.getAddress())
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "StakingVaultAlreadySet"
      );
    });
  });

  // ----------------------------------------------------------------
  // � 3. LIFECYCLE INTEGRITY
  // ----------------------------------------------------------------
  describe("🔄 Lifecycle Integrity", function () {
    it("Should revert burning an NFT with unclaimed principal", async () => {
      await unbondingManager
        .connect(owner)
        .createUnbondingPosition(await user1.getAddress(), 1, 0, 0, true);
      await expect(
        unbondingManager.connect(owner).burnNFT(0)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "PrincipalNotClaimedYet"
      );
    });

    it("Should revert burning an NFT with pending rewards", async () => {
      await unbondingManager
        .connect(owner)
        .createUnbondingPosition(
          await user1.getAddress(),
          1,
          1,
          await time.latest(),
          true
        );
      await time.increase(UNBONDING_PERIOD + 1);
      await unbondingManager.connect(owner).processPrincipalClaim(0); // Principal claimed

      await expect(
        unbondingManager.connect(owner).burnNFT(0)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "RewardsNotFullyClaimedYet"
      );
    });

    it("Invariant: claimedRewards should never exceed rewardAmount", async () => {
      const rewardAmount = ethers.parseEther("100");
      const now = await time.latest();
      await unbondingManager
        .connect(owner)
        .createUnbondingPosition(
          await user1.getAddress(),
          0,
          rewardAmount,
          now,
          true
        );

      // Fast-forward beyond the vesting period to ensure all rewards are available
      await time.increase(VESTING_DURATION + 1);
      await unbondingManager.connect(owner).processVestedRewardsClaim(0);

      // Verify claimed amount equals total reward amount
      const position = await unbondingManager.unbondingPositions(0);
      expect(position.claimedRewards).to.equal(rewardAmount);

      // Attempting to claim again should revert
      await expect(
        unbondingManager.connect(owner).processVestedRewardsClaim(0)
      ).to.be.revertedWithCustomError(unbondingManager, "AllRewardsClaimed");
    });
  });

  // ----------------------------------------------------------------
  // 🖼️ 4. ERC721 COMPLIANCE
  // ----------------------------------------------------------------
  describe("🖼️ ERC721 Compliance", function () {
    beforeEach(async () => {
      await unbondingManager
        .connect(owner)
        .createUnbondingPosition(await user1.getAddress(), 1, 0, 0, true);
      await unbondingManager
        .connect(owner)
        .createUnbondingPosition(await user2.getAddress(), 2, 0, 0, true);
    });

    it("Should correctly report totalSupply, balanceOf, and ownerOf", async () => {
      expect(await unbondingManager.totalSupply()).to.equal(2);
      expect(
        await unbondingManager.balanceOf(await user1.getAddress())
      ).to.equal(1);
      expect(
        await unbondingManager.balanceOf(await user2.getAddress())
      ).to.equal(1);
      expect(await unbondingManager.ownerOf(0)).to.equal(
        await user1.getAddress()
      );
      expect(await unbondingManager.ownerOf(1)).to.equal(
        await user2.getAddress()
      );
    });

    it("Should allow NFT transfer and correctly update ownership", async () => {
      await unbondingManager
        .connect(user1)
        .transferFrom(await user1.getAddress(), await user2.getAddress(), 0);
      expect(await unbondingManager.ownerOf(0)).to.equal(
        await user2.getAddress()
      );
      expect(
        await unbondingManager.balanceOf(await user1.getAddress())
      ).to.equal(0);
      expect(
        await unbondingManager.balanceOf(await user2.getAddress())
      ).to.equal(2);
    });

    it("Should not allow the new NFT owner to process claims", async () => {
      await unbondingManager
        .connect(user1)
        .transferFrom(await user1.getAddress(), await user2.getAddress(), 0);
      await time.increase(UNBONDING_PERIOD + 1);

      // This test is correct as processPrincipalClaim is onlyOwner protected.
      await expect(
        unbondingManager.connect(user2).processPrincipalClaim(0)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "OwnableUnauthorizedAccount"
      );
    });

    it("Should prevent old owner from transferring the NFT after it's sent", async () => {
      await unbondingManager
        .connect(user1)
        .transferFrom(await user1.getAddress(), await user2.getAddress(), 0);
      await expect(
        unbondingManager
          .connect(user1)
          .transferFrom(
            await user1.getAddress(),
            await nonOwner.getAddress(),
            0
          )
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "ERC721InsufficientApproval"
      );
    });
  });

  // ----------------------------------------------------------------
  // ⚙️ 5. BOUNDARY, OVERFLOW & EDGE CASES
  // ----------------------------------------------------------------
  describe("⚙️ Boundary, Overflow & Edge Cases", function () {
    it("Should handle creating a position with zero principal", async () => {
      await expect(
        unbondingManager
          .connect(owner)
          .createUnbondingPosition(await user1.getAddress(), 0, 1, 0, true)
      ).to.emit(unbondingManager, "UnbondingPositionCreated");
      const position = await unbondingManager.unbondingPositions(0);
      expect(position.principalAmount).to.equal(0);
    });

    it("Should handle creating a position with zero reward", async () => {
      await expect(
        unbondingManager
          .connect(owner)
          .createUnbondingPosition(await user1.getAddress(), 1, 0, 0, true)
      ).to.emit(unbondingManager, "UnbondingPositionCreated");
      const position = await unbondingManager.unbondingPositions(0);
      expect(position.rewardAmount).to.equal(0);
    });

    it("Should revert when creating a position for the zero address", async () => {
      await expect(
        unbondingManager
          .connect(owner)
          .createUnbondingPosition(ethers.ZeroAddress, 1, 1, 0, true)
      ).to.be.revertedWithCustomError(
        unbondingManager,
        "ERC721InvalidReceiver"
      );
    });
  });

  // ----------------------------------------------------------------
  // 📈 6. STRESS & SCALE TESTS
  // ----------------------------------------------------------------
  describe("📈 Stress & Scale Tests", function () {
    it("Should allow batch creation of multiple unbondings without collision", async () => {
      const NUM_TOKENS = 50;
      for (let i = 0; i < NUM_TOKENS; i++) {
        await unbondingManager.connect(owner).createUnbondingPosition(
          await user1.getAddress(),
          i + 1, // Use unique principal to differentiate
          i + 1,
          REWARDS_UNLOCK_TIMESTAMP,
          true
        );
        const position = await unbondingManager.unbondingPositions(i);
        expect(position.principalAmount).to.equal(i + 1);
      }
      expect(await unbondingManager.totalSupply()).to.equal(NUM_TOKENS);
      expect(
        await unbondingManager.balanceOf(await user1.getAddress())
      ).to.equal(NUM_TOKENS);
    });
  });
});
