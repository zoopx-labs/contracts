/**
 * @file deploy-staking.ts
 * @author ZoopX Labs
 * @date 2025-07-25
 *
 * @description This script deploys the entire TICS Staking Vault protocol to a specified network.
 * It deploys contracts in the correct order to handle dependencies and links them together.
 */

import { ethers, network } from "hardhat";
// FIX: The `time` helper is for local testing only. It cannot be used on a live testnet.
// We will use standard JavaScript to calculate the future timestamp.
// import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  Admin,
  ZTICS,
  UnbondingManager,
  BoostVault,
  TICS_Staking_Vault,
} from "../typechain-types";

async function main() {
  // On a live testnet, ethers.getSigners() will only return the account(s)
  // configured in hardhat.config.ts. We will use the first (and likely only)
  // account as the deployer and for all administrative roles.
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // For a testnet deployment, we can assign all roles to the deployer.
  const adminAccount = deployer;
  const keeperAccount = deployer;
  const treasuryAccount = deployer;

  console.log(
    "Admin, Keeper, and Treasury roles will be assigned to:",
    deployer.address
  );
  console.log(
    "Account balance:",
    (await ethers.provider.getBalance(deployer.address)).toString()
  );

  // --- 1. Define Core Parameters ---
  // The 5-month cliff date. Set this to a real future timestamp for mainnet.
  const fiveMonthsInSeconds = 5 * 30 * 24 * 60 * 60;
  // FIX: Calculate the timestamp using standard JavaScript Date.now() for live networks.
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const rewardsUnlockTimestamp = currentTimestamp + fiveMonthsInSeconds;
  console.log(
    `Rewards Unlock (Cliff) Timestamp set to: ${new Date(
      rewardsUnlockTimestamp * 1000
    ).toISOString()}`
  );

  // --- 2. Deploy Contracts in Order ---

  // Deploy Admin Contract
  const AdminFactory = await ethers.getContractFactory("Admin");
  const admin = (await AdminFactory.deploy(
    adminAccount.address,
    treasuryAccount.address
  )) as Admin;
  await admin.waitForDeployment();
  const adminAddress = await admin.getAddress();
  console.log(`Admin contract deployed to: ${adminAddress}`);

  // Deploy zTICS (temporary owner is deployer)
  const ZTICSFactory = await ethers.getContractFactory("zTICS");
  const zTICS = (await ZTICSFactory.deploy(deployer.address)) as ZTICS;
  await zTICS.waitForDeployment();
  const zTICSAddress = await zTICS.getAddress();
  console.log(`zTICS contract deployed to: ${zTICSAddress}`);

  // Deploy UnbondingManager (temporary owner is deployer)
  const UnbondingManagerFactory = await ethers.getContractFactory(
    "UnbondingManager"
  );
  const unbondingManager = (await UnbondingManagerFactory.deploy(
    deployer.address,
    rewardsUnlockTimestamp
  )) as UnbondingManager;
  await unbondingManager.waitForDeployment();
  const unbondingManagerAddress = await unbondingManager.getAddress();
  console.log(`UnbondingManager deployed to: ${unbondingManagerAddress}`);

  // Deploy BoostVault
  const BoostVaultFactory = await ethers.getContractFactory("BoostVault");
  const boostVault = (await BoostVaultFactory.deploy(
    adminAddress,
    zTICSAddress,
    ethers.ZeroAddress, // Placeholder for vault, will be set later
    ethers.parseEther("1000000") // Initial target TVL
  )) as BoostVault;
  await boostVault.waitForDeployment();
  const boostVaultAddress = await boostVault.getAddress();
  console.log(`BoostVault deployed to: ${boostVaultAddress}`);

  // Deploy TICS_Staking_Vault (The main contract)
  const TICSVaultFactory = await ethers.getContractFactory(
    "TICS_Staking_Vault"
  );
  const ticsVault = (await TICSVaultFactory.deploy(
    adminAddress,
    zTICSAddress,
    unbondingManagerAddress,
    boostVaultAddress,
    rewardsUnlockTimestamp
  )) as TICS_Staking_Vault;
  await ticsVault.waitForDeployment();
  const ticsVaultAddress = await ticsVault.getAddress();
  console.log(`TICS_Staking_Vault deployed to: ${ticsVaultAddress}`);

  // --- 3. Link Contracts & Transfer Ownership ---
  console.log("\nLinking contracts and setting permissions...");

  // Transfer ownership of zTICS to the vault
  await zTICS.connect(deployer).transferOwnership(ticsVaultAddress);
  console.log(`zTICS ownership transferred to Staking Vault.`);

  // Set the vault address in UnbondingManager, then transfer ownership
  await unbondingManager.connect(deployer).setStakingVault(ticsVaultAddress);
  await unbondingManager.connect(deployer).transferOwnership(ticsVaultAddress);
  console.log(
    `UnbondingManager linked and ownership transferred to Staking Vault.`
  );

  // Set the vault address in BoostVault
  await boostVault.connect(adminAccount).setTicsStakingVault(ticsVaultAddress);
  console.log(`BoostVault linked to Staking Vault.`);

  // Grant the KEEPER_ROLE
  const KEEPER_ROLE = await admin.KEEPER_ROLE();
  await admin
    .connect(adminAccount)
    .grantRole(KEEPER_ROLE, keeperAccount.address);
  console.log(`KEEPER_ROLE granted to: ${keeperAccount.address}`);

  console.log("\nDeployment complete!");
  console.log("----------------------------------------------------");
  console.log("ZoopX Staking Protocol Addresses:");
  console.log(`- Admin: ${adminAddress}`);
  console.log(`- zTICS: ${zTICSAddress}`);
  console.log(`- TICS_Staking_Vault: ${ticsVaultAddress}`);
  console.log(`- UnbondingManager: ${unbondingManagerAddress}`);
  console.log(`- BoostVault: ${boostVaultAddress}`);
  console.log("----------------------------------------------------");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
