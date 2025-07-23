/**
 * @file Test suite for the zTICS contract.
 * @author ZoopX Labs
 * @date 2025-07-20
 *
 * @description This file contains a comprehensive set of tests for the zTICS ERC20 token,
 * which includes functionalities for minting, burning, and EIP-2612 permits (gasless approvals).
 * These tests are structured using Hardhat, Ethers.js, and Chai to ensure the contract
 * behaves as expected under various conditions.
 */

import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"; // Added 'time' import
import { expect } from "chai";
import { ethers } from "hardhat";
import { Signature } from "ethers";
// Import the contract's type definition from TypeChain for strong type safety.
import { ZTICS } from "../typechain-types";

/**
 * @describe Top-level test suite for the zTICS contract.
 */
describe("zTICS Contract Tests", function () {
  // Declare state variables to be accessible throughout the tests.
  // These are initialized in the beforeEach hook for a clean state in every test.
  let zTICS: ZTICS;
  let owner: any;
  let vaultAddress: string;
  let otherAccount: any;
  let anotherAccount: any;

  /**
   * @function deployZticsFixture
   * @description Set up a fixture using hardhat-network-helpers to deploy the contract.
   * This optimization deploys the contract only once, snapshots the state,
   * and reverts to it for each test, which is much faster than repeated deployments.
   * @returns {Promise<object>} A promise resolving to an object with the contract instance and signers.
   */
  async function deployZticsFixture() {
    // Get the signers (accounts) needed for the tests.
    [owner, otherAccount, anotherAccount] = await ethers.getSigners();
    // The owner of the contract will be the vault.
    vaultAddress = owner.address;

    // Get the contract factory and deploy the zTICS contract.
    const ZTICSFactory = await ethers.getContractFactory("zTICS");
    // Cast the deployed contract to the ZTICS TypeChain type for type safety.
    const contract = (await ZTICSFactory.deploy(
      vaultAddress
    )) as unknown as ZTICS;

    // Return all the necessary components for the tests.
    return {
      zTICS: contract,
      owner,
      vaultAddress,
      otherAccount,
      anotherAccount,
    };
  }

  /**
   * @description Use a beforeEach hook to ensure a fresh state for every test case.
   * It loads the fixture, which resets the blockchain state to the post-deployment snapshot,
   * and reassigns all test variables. This prevents tests from interfering with each other.
   */
  beforeEach(async () => {
    const fixture = await loadFixture(deployZticsFixture);
    zTICS = fixture.zTICS;
    owner = fixture.owner;
    vaultAddress = fixture.vaultAddress;
    otherAccount = fixture.otherAccount;
    anotherAccount = fixture.anotherAccount;
  });

  /**
   * @describe Tests for the contract's deployment and initial state.
   */
  describe("Deployment", function () {
    /**
     * @it Should correctly set the token's name and symbol upon deployment.
     */
    it("Should set the correct name and symbol", async function () {
      expect(await zTICS.name()).to.equal("ZoopX Staked TICS");
      expect(await zTICS.symbol()).to.equal("zTICS");
    });

    /**
     * @it Should assign the deployer's address as the contract owner (the vault).
     */
    it("Should correctly assign the vault as the contract's owner", async function () {
      expect(await zTICS.owner()).to.equal(vaultAddress);
    });

    /**
     * @it Should verify that the token has 18 decimals, as is standard.
     */
    it("Should have 18 decimals", async function () {
      expect(await zTICS.decimals()).to.equal(18);
    });

    /**
     * @it Should confirm that the initial total supply of the token is zero.
     */
    it("Should start with a total supply of zero", async function () {
      expect(await zTICS.totalSupply()).to.equal(0);
    });
  });

  /**
   * @describe Tests for the minting functionality.
   */
  describe("Minting", function () {
    /**
     * @it It should allow the contract owner to mint new tokens to any address.
     */
    it("Should allow the owner to mint tokens", async function () {
      // Define the amount to mint using ethers for correct formatting.
      const mintAmount = ethers.parseEther("1000");
      // The owner calls the mint function.
      await zTICS.mint(otherAccount.address, mintAmount);

      // Assert that the balance and total supply have updated correctly.
      expect(await zTICS.balanceOf(otherAccount.address)).to.equal(mintAmount);
      expect(await zTICS.totalSupply()).to.equal(mintAmount);
    });

    /**
     * @it It should prevent any account other than the owner from minting tokens.
     */
    it("Should FAIL if a non-owner tries to mint", async function () {
      const mintAmount = ethers.parseEther("1000");
      // Connect as `otherAccount` to simulate a non-owner call.
      const zTICSAsOther = zTICS.connect(otherAccount);

      // Expect this transaction to be reverted with the specific error from OpenZeppelin's Ownable.
      await expect(
        zTICSAsOther.mint(anotherAccount.address, mintAmount)
      ).to.be.revertedWithCustomError(zTICS, "OwnableUnauthorizedAccount");
    });
  });

  /**
   * @describe Tests for the burning functionality.
   */
  describe("Burning", function () {
    /**
     * @it It should allow the contract owner to burn tokens from any address.
     */
    it("Should allow the owner to burn tokens", async function () {
      const initialAmount = ethers.parseEther("1000");
      const burnAmount = ethers.parseEther("400");
      // First, mint some tokens to have a balance to burn.
      await zTICS.mint(otherAccount.address, initialAmount);
      // Then, the owner calls the burn function.
      await zTICS.burn(otherAccount.address, burnAmount);

      // Calculate the expected final balance and assert the state is correct.
      const expectedFinalAmount = initialAmount - burnAmount;
      expect(await zTICS.balanceOf(otherAccount.address)).to.equal(
        expectedFinalAmount
      );
      expect(await zTICS.totalSupply()).to.equal(expectedFinalAmount);
    });

    /**
     * @it It should prevent any account other than the owner from burning tokens.
     */
    it("Should FAIL if a non-owner tries to burn", async function () {
      const initialAmount = ethers.parseEther("1000");
      await zTICS.mint(otherAccount.address, initialAmount);
      // Connect as `otherAccount` to simulate a non-owner call.
      const zTICSAsOther = zTICS.connect(otherAccount);

      // Expect this transaction to be reverted with the correct custom error.
      await expect(
        zTICSAsOther.burn(otherAccount.address, initialAmount)
      ).to.be.revertedWithCustomError(zTICS, "OwnableUnauthorizedAccount");
    });
  });

  /**
   * @describe Tests for the EIP-2612 permit functionality for gasless approvals.
   */
  describe("Permit (Gasless Approval)", function () {
    /**
     * @it It should allow a user to approve a spender by signing a message, without sending a transaction.
     */
    it("Should allow setting allowance via EIP-2612 permit", async function () {
      const spenderAddress = anotherAccount.address;
      const permitAmount = ethers.parseEther("500");
      // Use Hardhat's time.latest() to get the current block timestamp and add 3600 seconds (1 hour)
      const deadline = (await time.latest()) + 3600;
      // Get the current nonce for the signing account.
      const nonce = await zTICS.nonces(otherAccount.address);
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // Define the EIP-712 domain separator data.
      const domain = {
        name: await zTICS.name(),
        version: "1",
        chainId: chainId,
        verifyingContract: await zTICS.getAddress(),
      };

      // Define the EIP-712 typed data structure for the permit.
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      // Define the message that the user (`otherAccount`) will sign.
      const message = {
        owner: otherAccount.address,
        spender: spenderAddress,
        value: permitAmount,
        nonce,
        deadline,
      };

      // The user signs the typed data. This happens off-chain.
      const signature = await otherAccount.signTypedData(
        domain,
        types,
        message
      );
      // Parse the signature into its v, r, s components using the modern Ethers v6 approach.
      const { v, r, s } = Signature.from(signature);

      // Now, anyone (e.g., the owner or a relayer) can submit the permit transaction.
      await zTICS.permit(
        otherAccount.address,
        spenderAddress,
        permitAmount,
        deadline,
        v,
        r,
        s
      );

      // Assert that the allowance was set correctly for the spender.
      expect(
        await zTICS.allowance(otherAccount.address, spenderAddress)
      ).to.equal(permitAmount);
    });
  });
});
