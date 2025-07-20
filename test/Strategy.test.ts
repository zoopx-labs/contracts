/*
 * INSTRUCTIONS:
 * 1. Create a new file in your `test/` directory named `Strategy.test.ts`.
 * 2. Paste all the code below into this new file.
 * 3. Run the tests from your terminal using the command: `npx hardhat test`
 */

import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Strategy } from "../typechain-types";

describe("Strategy Contract Tests", function () {
  /**
   * @function deployStrategyFixture
   * @description Sets up the initial state for all tests by deploying the Strategy contract.
   */
  async function deployStrategyFixture() {
    // Get test wallets
    const [owner, otherAccount, validator1, validator2, validator3] =
      await ethers.getSigners();

    // Deploy the Strategy contract, with 'owner' simulating the Admin contract
    const StrategyFactory = await ethers.getContractFactory("Strategy");
    const strategyContract = (await StrategyFactory.deploy(
      owner.address
    )) as Strategy;

    return {
      strategyContract,
      owner,
      otherAccount,
      validator1,
      validator2,
      validator3,
      StrategyFactory,
    };
  }

  // 1. Deployment Tests
  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      const { strategyContract, owner } = await loadFixture(
        deployStrategyFixture
      );
      expect(await strategyContract.owner()).to.equal(owner.address);
    });

    it("Should start with an empty list of validators", async function () {
      const { strategyContract } = await loadFixture(deployStrategyFixture);
      expect(await strategyContract.getValidatorCount()).to.equal(0);
      expect(await strategyContract.getValidators()).to.be.an("array").that.is
        .empty;
    });

    it("Should revert if the initial admin address is the zero address", async function () {
      const { StrategyFactory } = await loadFixture(deployStrategyFixture);
      // OpenZeppelin's Ownable constructor reverts with a custom error
      await expect(StrategyFactory.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(StrategyFactory, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });
  });

  // 2. Validator Management & Access Control
  describe("Validator Management", function () {
    it("Should allow the owner to add a validator", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );

      await expect(strategyContract.addValidator(validator1.address))
        .to.emit(strategyContract, "ValidatorAdded")
        .withArgs(validator1.address);

      expect(await strategyContract.isValidator(validator1.address)).to.be.true;
      expect(await strategyContract.getValidatorCount()).to.equal(1);
      expect(await strategyContract.getValidators()).to.include(
        validator1.address
      );
    });

    it("Should FAIL if a non-owner tries to add a validator", async function () {
      const { strategyContract, otherAccount, validator1 } = await loadFixture(
        deployStrategyFixture
      );

      await expect(
        strategyContract.connect(otherAccount).addValidator(validator1.address)
      )
        .to.be.revertedWithCustomError(
          strategyContract,
          "OwnableUnauthorizedAccount"
        )
        .withArgs(otherAccount.address);
    });

    it("Should revert when adding the zero address as a validator", async function () {
      const { strategyContract } = await loadFixture(deployStrategyFixture);
      await expect(
        strategyContract.addValidator(ethers.ZeroAddress)
      ).to.be.revertedWith("Strategy: Validator address cannot be zero");
    });

    it("Should revert when adding an existing validator", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await strategyContract.addValidator(validator1.address);

      await expect(
        strategyContract.addValidator(validator1.address)
      ).to.be.revertedWith("Strategy: Validator already exists");
    });

    it("Should allow the owner to remove a validator", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await strategyContract.addValidator(validator1.address);

      await expect(strategyContract.removeValidator(validator1.address))
        .to.emit(strategyContract, "ValidatorRemoved")
        .withArgs(validator1.address);

      expect(await strategyContract.isValidator(validator1.address)).to.be
        .false;
      expect(await strategyContract.getValidatorCount()).to.equal(0);
    });

    it("Should FAIL if a non-owner tries to remove a validator", async function () {
      const { strategyContract, otherAccount, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await strategyContract.addValidator(validator1.address);

      await expect(
        strategyContract
          .connect(otherAccount)
          .removeValidator(validator1.address)
      )
        .to.be.revertedWithCustomError(
          strategyContract,
          "OwnableUnauthorizedAccount"
        )
        .withArgs(otherAccount.address);
    });

    it("Should revert when trying to remove a non-existent validator", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await expect(
        strategyContract.removeValidator(validator1.address)
      ).to.be.revertedWith("Strategy: Validator does not exist");
    });

    it("Should allow a removed validator to be re-added", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await strategyContract.addValidator(validator1.address);
      await strategyContract.removeValidator(validator1.address);
      await strategyContract.addValidator(validator1.address);

      expect(await strategyContract.isValidator(validator1.address)).to.be.true;
      expect(await strategyContract.getValidatorCount()).to.equal(1);
      expect(await strategyContract.getValidators()).to.include(
        validator1.address
      );
    });
  });

  // 3. Gas-Optimized Removal Logic
  describe("Gas-Optimized Removal (Swap and Pop)", function () {
    it("Should correctly remove a validator from the middle of the list", async function () {
      const { strategyContract, validator1, validator2, validator3 } =
        await loadFixture(deployStrategyFixture);
      await strategyContract.addValidator(validator1.address);
      await strategyContract.addValidator(validator2.address);
      await strategyContract.addValidator(validator3.address);

      await strategyContract.removeValidator(validator2.address);

      const validators = await strategyContract.getValidators();
      expect(validators.length).to.equal(2);
      expect(validators).to.include(validator1.address);
      expect(validators).to.include(validator3.address);
      expect(validators).to.not.include(validator2.address);
      expect(await strategyContract.isValidator(validator2.address)).to.be
        .false;
    });

    it("Should correctly remove the last validator in the list", async function () {
      const { strategyContract, validator1, validator2 } = await loadFixture(
        deployStrategyFixture
      );
      await strategyContract.addValidator(validator1.address);
      await strategyContract.addValidator(validator2.address);

      await strategyContract.removeValidator(validator2.address);

      const validators = await strategyContract.getValidators();
      expect(validators.length).to.equal(1);
      expect(validators[0]).to.equal(validator1.address);
      expect(await strategyContract.isValidator(validator2.address)).to.be
        .false;
    });
  });

  // 4. Security & Edge Cases
  describe("Security & Edge Cases", function () {
    it("Should handle multiple validator additions and removals correctly", async function () {
      const { strategyContract } = await loadFixture(deployStrategyFixture);
      const validators = Array.from(
        { length: 10 },
        () => ethers.Wallet.createRandom().address
      );

      for (const addr of validators) {
        await strategyContract.addValidator(addr);
        expect(await strategyContract.isValidator(addr)).to.be.true;
      }
      expect(await strategyContract.getValidatorCount()).to.equal(10);

      for (const addr of validators.slice(0, 5)) {
        await strategyContract.removeValidator(addr);
        expect(await strategyContract.isValidator(addr)).to.be.false;
      }

      expect(await strategyContract.getValidatorCount()).to.equal(5);
    });

    it("Validator list and mapping should always stay in sync", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await strategyContract.addValidator(validator1.address);
      const list = await strategyContract.getValidators();

      expect(list.includes(validator1.address)).to.equal(
        await strategyContract.isValidator(validator1.address)
      );

      await strategyContract.removeValidator(validator1.address);
      const newList = await strategyContract.getValidators();

      expect(newList.includes(validator1.address)).to.equal(
        await strategyContract.isValidator(validator1.address)
      );
    });

    it("Should revert if trying to remove from an empty list", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await expect(
        strategyContract.removeValidator(validator1.address)
      ).to.be.revertedWith("Strategy: Validator does not exist");
    });

    it("Should treat addresses as case-insensitive for validator matching", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      await strategyContract.addValidator(validator1.address);

      expect(await strategyContract.isValidator(validator1.address)).to.be.true;

      const lowerCase = validator1.address.toLowerCase();
      expect(await strategyContract.isValidator(lowerCase)).to.be.true;
    });

    it("Should have a reasonable gas cost for adding a validator", async function () {
      const { strategyContract, validator1 } = await loadFixture(
        deployStrategyFixture
      );
      const tx = await strategyContract.addValidator.send(validator1.address);
      const receipt = await tx.wait();
      expect(receipt?.gasUsed).to.be.lessThan(150000);
    });
  });
});
