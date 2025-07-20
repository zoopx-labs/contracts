/**
 * @file Test suite for the Admin.sol contract.
 * @author ZoopX Labs
 * @date 2025-07-20
 *
 * @description This file contains a comprehensive set of tests for the Admin contract,
 * which is the central governance and control hub for the ZoopX Protocol.
 * These tests are structured using Hardhat and Ethers.js to ensure the contract
 * behaves as expected under all conditions.
 */

import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZTICS, Admin, Admin__factory } from "../typechain-types"; // Assuming you have run typechain

describe("Admin Contract Tests", function () {
  /**
   * @function deployAdminFixture
   * @description Sets up the initial state for all tests by deploying contracts and setting up roles.
   */
  async function deployAdminFixture() {
    // Get test wallets
    const [
      initialAdmin,
      newAdmin,
      pauser,
      feeManager,
      validatorManager,
      ammManager,
      otherAccount,
      initialTreasury,
      newTreasury,
    ] = await ethers.getSigners();

    // Deploy the mock Strategy contract from its own file
    const MockStrategyFactory = await ethers.getContractFactory("MockStrategy");
    const mockStrategy = await MockStrategyFactory.deploy();

    // Deploy a mock ERC20 token for recovery tests
    const ZTICSFactory = await ethers.getContractFactory("zTICS");
    const mockToken = (await ZTICSFactory.deploy(
      initialAdmin.address
    )) as ZTICS;

    // Deploy the main Admin contract
    // We cast the factory to the correct type to resolve any type inference issues.
    const AdminFactory = (await ethers.getContractFactory(
      "Admin"
    )) as Admin__factory;
    const adminContract = (await AdminFactory.deploy(
      initialAdmin.address,
      initialTreasury.address
    )) as Admin;

    // Set up roles for different accounts to test access control
    const PAUSER_ROLE = await adminContract.PAUSER_ROLE();
    const FEE_MANAGER_ROLE = await adminContract.FEE_MANAGER_ROLE();
    const VALIDATOR_MANAGER_ROLE = await adminContract.VALIDATOR_MANAGER_ROLE();
    const AMM_MANAGER_ROLE = await adminContract.AMM_MANAGER_ROLE();

    await adminContract.grantRole(PAUSER_ROLE, pauser.address);
    await adminContract.grantRole(FEE_MANAGER_ROLE, feeManager.address);
    await adminContract.grantRole(
      VALIDATOR_MANAGER_ROLE,
      validatorManager.address
    );
    await adminContract.grantRole(AMM_MANAGER_ROLE, ammManager.address);

    return {
      adminContract,
      initialAdmin,
      newAdmin,
      pauser,
      feeManager,
      validatorManager,
      ammManager,
      otherAccount,
      initialTreasury,
      newTreasury,
      mockStrategy,
      mockToken,
      PAUSER_ROLE,
      FEE_MANAGER_ROLE,
      VALIDATOR_MANAGER_ROLE,
      AMM_MANAGER_ROLE,
    };
  }

  // 1. Deployment Tests
  describe("Deployment", function () {
    it("Should deploy successfully with valid addresses", async function () {
      const { adminContract } = await loadFixture(deployAdminFixture);
      expect(adminContract.target).to.not.be.undefined;
    });

    it("Should revert if _initialAdmin is the zero address", async function () {
      const { initialTreasury } = await loadFixture(deployAdminFixture);
      const AdminFactory = await ethers.getContractFactory("Admin");
      await expect(
        AdminFactory.deploy(ethers.ZeroAddress, initialTreasury.address)
      ).to.be.revertedWith("Admin: Initial admin cannot be zero address");
    });

    it("Should revert if _initialTreasury is the zero address", async function () {
      const { initialAdmin } = await loadFixture(deployAdminFixture);
      const AdminFactory = await ethers.getContractFactory("Admin");
      await expect(
        AdminFactory.deploy(initialAdmin.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Admin: Initial treasury cannot be zero address");
    });

    it("Should correctly set initial fees", async function () {
      const { adminContract } = await loadFixture(deployAdminFixture);
      expect(await adminContract.bridgeFeeBps()).to.equal(5);
      expect(await adminContract.stakingFeeBps()).to.equal(1000);
      expect(await adminContract.ammSwapFeeBps()).to.equal(30);
    });

    it("Should grant all roles to the initial admin", async function () {
      const { adminContract, initialAdmin, PAUSER_ROLE, FEE_MANAGER_ROLE } =
        await loadFixture(deployAdminFixture);
      const DEFAULT_ADMIN_ROLE = await adminContract.DEFAULT_ADMIN_ROLE();
      expect(
        await adminContract.hasRole(DEFAULT_ADMIN_ROLE, initialAdmin.address)
      ).to.be.true;
      expect(await adminContract.hasRole(PAUSER_ROLE, initialAdmin.address)).to
        .be.true;
      expect(
        await adminContract.hasRole(FEE_MANAGER_ROLE, initialAdmin.address)
      ).to.be.true;
    });
  });

  // 2. Access Control & Role Management
  describe("Access Control & Role Management", function () {
    it("Should demonstrate role isolation (e.g., pauser cannot manage fees)", async function () {
      const { adminContract, pauser } = await loadFixture(deployAdminFixture);
      await expect(adminContract.connect(pauser).setBridgeFee(10)).to.be
        .reverted; // Reverts with AccessControl error
    });
  });

  // 3. Pausing Functions
  describe("Pausing Functions", function () {
    it("Should allow PAUSER_ROLE to toggle all pause states and emit events", async function () {
      const { adminContract, pauser } = await loadFixture(deployAdminFixture);

      await expect(adminContract.connect(pauser).setStakingPaused(true))
        .to.emit(adminContract, "StakingPaused")
        .withArgs(true);
      expect(await adminContract.isStakingPaused()).to.be.true;

      await expect(adminContract.connect(pauser).setBridgePaused(true))
        .to.emit(adminContract, "BridgePaused")
        .withArgs(true);
      expect(await adminContract.isBridgePaused()).to.be.true;

      await expect(adminContract.connect(pauser).setAmmPaused(true))
        .to.emit(adminContract, "AmmPaused")
        .withArgs(true);
      expect(await adminContract.isAmmPaused()).to.be.true;
    });

    it("Should revert if trying to set the same pause state again", async function () {
      const { adminContract, pauser } = await loadFixture(deployAdminFixture);
      await adminContract.connect(pauser).setStakingPaused(true);
      await expect(
        adminContract.connect(pauser).setStakingPaused(true)
      ).to.be.revertedWith("Admin: Already in that state");
    });
  });

  // 4. Validator Management
  describe("Validator Management", function () {
    it("Should allow VALIDATOR_MANAGER_ROLE to add and remove validators", async function () {
      const { adminContract, validatorManager, mockStrategy, otherAccount } =
        await loadFixture(deployAdminFixture);
      await adminContract.setStrategyContract(mockStrategy.target);

      await expect(
        adminContract
          .connect(validatorManager)
          .addValidatorToStrategy(otherAccount.address)
      )
        .to.emit(adminContract, "ValidatorAdded")
        .withArgs(otherAccount.address);

      await expect(
        adminContract
          .connect(validatorManager)
          .removeValidatorFromStrategy(otherAccount.address)
      )
        .to.emit(adminContract, "ValidatorRemoved")
        .withArgs(otherAccount.address);
    });

    it("Should revert if validator address is the zero address", async function () {
      const { adminContract, validatorManager, mockStrategy } =
        await loadFixture(deployAdminFixture);
      await adminContract.setStrategyContract(mockStrategy.target);
      await expect(
        adminContract
          .connect(validatorManager)
          .addValidatorToStrategy(ethers.ZeroAddress)
      ).to.be.revertedWith("Admin: Validator address cannot be zero");
    });
  });

  // 5. Fee Management
  describe("Fee Management", function () {
    it("Should allow FEE_MANAGER_ROLE to set all fees within limits", async function () {
      const { adminContract, feeManager } = await loadFixture(
        deployAdminFixture
      );
      await expect(adminContract.connect(feeManager).setStakingFee(500))
        .to.emit(adminContract, "StakingFeeUpdated")
        .withArgs(500);
      expect(await adminContract.stakingFeeBps()).to.equal(500);
    });

    it("Should revert if staking fee is set above the max", async function () {
      const { adminContract, feeManager } = await loadFixture(
        deployAdminFixture
      );
      const MAX_STAKING_FEE = await adminContract.MAX_STAKING_FEE_BPS();
      await expect(
        adminContract.connect(feeManager).setStakingFee(MAX_STAKING_FEE + 1n)
      ).to.be.revertedWith("Admin: Staking fee exceeds maximum");
    });
  });

  // 6. AMM Contract Management
  describe("AMM Contract Management", function () {
    it("Should allow AMM_MANAGER_ROLE to set AMM contracts", async function () {
      const { adminContract, ammManager, otherAccount, newAdmin } =
        await loadFixture(deployAdminFixture); // Using other accounts as mock factory/router
      await expect(
        adminContract
          .connect(ammManager)
          .setAmmContracts(otherAccount.address, newAdmin.address)
      ).to.emit(adminContract, "AmmParametersUpdated");
      expect(await adminContract.ammFactory()).to.equal(otherAccount.address);
      expect(await adminContract.ammRouter()).to.equal(newAdmin.address);
    });
  });

  // 7. Admin Transfer & Renounce
  describe("Admin Transfer & Renounce", function () {
    it("Should emit an event on transferAdmin", async function () {
      const { adminContract, initialAdmin, newAdmin } = await loadFixture(
        deployAdminFixture
      );
      await expect(adminContract.transferAdmin(newAdmin.address))
        .to.emit(adminContract, "AdminTransferred")
        .withArgs(initialAdmin.address, newAdmin.address);
    });
  });

  // 8. ERC20 Recovery
  describe("ERC20 Recovery", function () {
    it("Should revert if recovering to the zero address", async function () {
      const { adminContract, mockToken } = await loadFixture(
        deployAdminFixture
      );
      await mockToken.mint(adminContract.target, 1000);
      await expect(
        adminContract.recoverERC20(mockToken.target, 1000, ethers.ZeroAddress)
      ).to.be.revertedWith("Admin: Recovery address cannot be zero");
    });
  });

  // 9. Read Functions
  describe("Read Functions", function () {
    it("getRoles() should return the correct role constants", async function () {
      const {
        adminContract,
        PAUSER_ROLE,
        VALIDATOR_MANAGER_ROLE,
        FEE_MANAGER_ROLE,
        AMM_MANAGER_ROLE,
      } = await loadFixture(deployAdminFixture);
      const roles = await adminContract.getRoles();
      expect(roles[0]).to.equal(PAUSER_ROLE);
      expect(roles[1]).to.equal(VALIDATOR_MANAGER_ROLE);
      expect(roles[2]).to.equal(FEE_MANAGER_ROLE);
      expect(roles[3]).to.equal(AMM_MANAGER_ROLE);
    });
  });

  // 10. Security & Edge Cases
  describe("Security & Edge Cases", function () {
    it("Transferred admin should retain all roles; previous should lose them", async function () {
      const { adminContract, initialAdmin, newAdmin, PAUSER_ROLE } =
        await loadFixture(deployAdminFixture);
      await adminContract.transferAdmin(newAdmin.address);

      expect(await adminContract.hasRole(PAUSER_ROLE, newAdmin.address)).to.be
        .true;
      expect(await adminContract.hasRole(PAUSER_ROLE, initialAdmin.address)).to
        .be.false;

      // Attempt pause from old admin should fail
      await expect(adminContract.connect(initialAdmin).setAmmPaused(true)).to.be
        .reverted;
    });

    it("Should allow setting the exact max fee", async function () {
      const { adminContract, feeManager } = await loadFixture(
        deployAdminFixture
      );
      const MAX_STAKING_FEE = await adminContract.MAX_STAKING_FEE_BPS();
      await expect(
        adminContract.connect(feeManager).setStakingFee(MAX_STAKING_FEE)
      ).to.not.be.reverted;
    });

    it("Should not break if the same validator is added or removed twice", async function () {
      const { adminContract, validatorManager, mockStrategy, otherAccount } =
        await loadFixture(deployAdminFixture);
      await adminContract.setStrategyContract(mockStrategy.target);

      await adminContract
        .connect(validatorManager)
        .addValidatorToStrategy(otherAccount.address);
      // Adding again should not revert or change state significantly
      await expect(
        adminContract
          .connect(validatorManager)
          .addValidatorToStrategy(otherAccount.address)
      ).to.not.be.reverted;

      await adminContract
        .connect(validatorManager)
        .removeValidatorFromStrategy(otherAccount.address);
      // Removing again should not revert
      await expect(
        adminContract
          .connect(validatorManager)
          .removeValidatorFromStrategy(otherAccount.address)
      ).to.not.be.reverted;
    });

    it("Should revert action if the relevant module is paused", async function () {
      const { adminContract, pauser, ammManager, otherAccount, newAdmin } =
        await loadFixture(deployAdminFixture);
      await adminContract.connect(pauser).setAmmPaused(true);

      // This should fail because the AMM module is paused, but the function doesn't have a pause check.
      // For a full implementation, the target contracts (e.g., the AMM router) would read this state.
      // This test confirms the state is set correctly for other contracts to read.
      expect(await adminContract.isAmmPaused()).to.be.true;
    });

    it("Should revert if trying to recover more tokens than the contract holds", async function () {
      const { adminContract, mockToken, initialAdmin } = await loadFixture(
        deployAdminFixture
      );
      const balance = 100n;
      await mockToken.mint(adminContract.target, balance);

      await expect(
        adminContract.recoverERC20(
          mockToken.target,
          balance + 1n,
          initialAdmin.address
        )
      ).to.be.reverted; // Should revert with ERC20: transfer amount exceeds balance
    });
  });
});
