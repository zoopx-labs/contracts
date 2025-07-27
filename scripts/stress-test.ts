/**
 * @file deploy-staking.ts
 * @author ZoopX Labs
 * @date 2025-07-25
 *
 * @description This script deploys the entire TICS Staking Vault protocol to a specified network.
 * It deploys contracts in the correct order, links them, and then verifies them on the block explorer.
 */

import { ethers, network, run } from "hardhat";
import {
  Admin,
  ZTICS,
  Strategy,
  UnbondingManager,
  BoostVault,
  TICS_Staking_Vault,
} from "../typechain-types";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

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
  const fiveMonthsInSeconds = 5 * 30 * 24 * 60 * 60;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const rewardsUnlockTimestamp = currentTimestamp + fiveMonthsInSeconds;
  const initialTargetTvl = ethers.parseEther("1000000"); // Initial target TVL for BoostVault
  console.log(
    `Rewards Unlock (Cliff) Timestamp set to: ${new Date(
      rewardsUnlockTimestamp * 1000
    ).toISOString()}`
  );

  // --- 2. Deploy Contracts in Order ---

  console.log("\n--- Starting Contract Deployment ---");

  // Deploy Admin Contract
  const AdminFactory = await ethers.getContractFactory("Admin");
  const admin = (await AdminFactory.deploy(
    adminAccount.address,
    treasuryAccount.address
  )) as Admin;
  await admin.waitForDeployment();
  const adminAddress = await admin.getAddress();
  console.log(`✅ Admin contract deployed to: ${adminAddress}`);

  // Deploy zTICS (temporary owner is deployer)
  const ZTICSFactory = await ethers.getContractFactory("zTICS");
  const zTICS = (await ZTICSFactory.deploy(deployer.address)) as ZTICS;
  await zTICS.waitForDeployment();
  const zTICSAddress = await zTICS.getAddress();
  console.log(`✅ zTICS contract deployed to: ${zTICSAddress}`);

  // Deploy Strategy Contract
  const StrategyFactory = await ethers.getContractFactory("Strategy");
  const strategy = (await StrategyFactory.deploy(adminAddress)) as Strategy;
  await strategy.waitForDeployment();
  const strategyAddress = await strategy.getAddress();
  console.log(`✅ Strategy contract deployed to: ${strategyAddress}`);

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
  console.log(`✅ UnbondingManager deployed to: ${unbondingManagerAddress}`);

  // Deploy BoostVault
  const BoostVaultFactory = await ethers.getContractFactory("BoostVault");
  const boostVault = (await BoostVaultFactory.deploy(
    adminAddress,
    zTICSAddress,
    ethers.ZeroAddress, // Placeholder for vault, will be set later
    initialTargetTvl
  )) as BoostVault;
  await boostVault.waitForDeployment();
  const boostVaultAddress = await boostVault.getAddress();
  console.log(`✅ BoostVault deployed to: ${boostVaultAddress}`);

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
  console.log(`✅ TICS_Staking_Vault deployed to: ${ticsVaultAddress}`);

  // --- 3. Link Contracts, Set Permissions & Verify ---
  console.log("\n--- Linking Contracts & Verifying Configuration ---");

  // Transfer ownership of zTICS to the vault
  console.log(`\nSetting ownership of zTICS to TICS_Staking_Vault...`);
  await zTICS.connect(deployer).transferOwnership(ticsVaultAddress);
  console.log(
    `   Action: transferOwnership(${ticsVaultAddress}) on zTICS complete.`
  );
  const zTicsOwner = await zTICS.owner();
  console.log(`   ✅ Verification: zTICS owner is now ${zTicsOwner}`);

  // Link the Strategy contract to the vault
  console.log(`\nLinking Strategy contract to TICS_Staking_Vault...`);
  await ticsVault.connect(adminAccount).setStrategy(strategyAddress);
  console.log(
    `   Action: setStrategy(${strategyAddress}) on TICS_Staking_Vault complete.`
  );
  const vaultStrategyAddress = await ticsVault.strategyContract();
  console.log(
    `   ✅ Verification: Vault's strategy address is now ${vaultStrategyAddress}`
  );

  // Set the vault address in UnbondingManager, then transfer ownership
  console.log(`\nLinking UnbondingManager to TICS_Staking_Vault...`);
  await unbondingManager.connect(deployer).setStakingVault(ticsVaultAddress);
  console.log(
    `   Action: setStakingVault(${ticsVaultAddress}) on UnbondingManager complete.`
  );
  await unbondingManager.connect(deployer).transferOwnership(ticsVaultAddress);
  console.log(
    `   Action: transferOwnership(${ticsVaultAddress}) on UnbondingManager complete.`
  );
  const unbondingManagerOwner = await unbondingManager.owner();
  console.log(
    `   ✅ Verification: UnbondingManager owner is now ${unbondingManagerOwner}`
  );

  // Set the vault address in BoostVault
  console.log(`\nLinking BoostVault to TICS_Staking_Vault...`);
  await boostVault.connect(adminAccount).setTicsStakingVault(ticsVaultAddress);
  console.log(
    `   Action: setTicsStakingVault(${ticsVaultAddress}) on BoostVault complete.`
  );
  const boostVaultsTicsVault = await boostVault.ticsStakingVault();
  console.log(
    `   ✅ Verification: BoostVault's staking vault address is now ${boostVaultsTicsVault}`
  );

  // Verify the BoostVault address was set correctly in the TICS_Staking_Vault constructor
  console.log(`\nVerifying BoostVault address in TICS_Staking_Vault...`);
  const ticsVaultsBoostVault = await ticsVault.boostVault();
  console.log(
    `   ✅ Verification: TICS_Staking_Vault's boost vault address is ${ticsVaultsBoostVault}`
  );

  // Grant the KEEPER_ROLE
  console.log(`\nGranting KEEPER_ROLE...`);
  const KEEPER_ROLE = await admin.KEEPER_ROLE();
  await admin
    .connect(adminAccount)
    .grantRole(KEEPER_ROLE, keeperAccount.address);
  console.log(
    `   Action: grantRole(KEEPER_ROLE, ${keeperAccount.address}) on Admin complete.`
  );
  const hasKeeperRole = await admin.hasRole(KEEPER_ROLE, keeperAccount.address);
  console.log(
    `   ✅ Verification: Address ${keeperAccount.address} has KEEPER_ROLE: ${hasKeeperRole}`
  );

  console.log("\n\n🚀 Deployment and Configuration Complete! 🚀");
  console.log("====================================================");
  console.log("ZoopX Staking Protocol Addresses:");
  console.log(`- Admin:              ${adminAddress}`);
  console.log(`- zTICS:              ${zTICSAddress}`);
  console.log(`- Strategy:           ${strategyAddress}`);
  console.log(`- TICS_Staking_Vault: ${ticsVaultAddress}`);
  console.log(`- UnbondingManager:   ${unbondingManagerAddress}`);
  console.log(`- BoostVault:         ${boostVaultAddress}`);
  console.log("====================================================");

  // --- 4. Verify Contracts on Block Explorer (if not on a local network) ---
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n--- Verifying Contracts on Block Explorer ---");
    console.log("Waiting 30 seconds for block explorer to index contracts...");
    await new Promise((resolve) => setTimeout(resolve, 30000)); // 30s delay

    const verifyContract = async (
      name: string,
      address: string,
      constructorArguments: any[]
    ) => {
      try {
        console.log(`\nVerifying ${name}...`);
        await run("verify:verify", {
          address: address,
          constructorArguments: constructorArguments,
        });
        console.log(`   ✅ ${name} verified successfully!`);
      } catch (error: any) {
        if (error.message.toLowerCase().includes("already verified")) {
          console.log(`   ☑️ ${name} is already verified.`);
        } else {
          console.error(`   ❌ Error verifying ${name}:`, error.message);
        }
      }
    };

    await verifyContract("Admin", adminAddress, [
      adminAccount.address,
      treasuryAccount.address,
    ]);
    await verifyContract("zTICS", zTICSAddress, [deployer.address]);
    await verifyContract("Strategy", strategyAddress, [adminAddress]);
    await verifyContract("UnbondingManager", unbondingManagerAddress, [
      deployer.address,
      rewardsUnlockTimestamp,
    ]);
    await verifyContract("BoostVault", boostVaultAddress, [
      adminAddress,
      zTICSAddress,
      ethers.ZeroAddress,
      initialTargetTvl,
    ]);
    await verifyContract("TICS_Staking_Vault", ticsVaultAddress, [
      adminAddress,
      zTICSAddress,
      unbondingManagerAddress,
      boostVaultAddress,
      rewardsUnlockTimestamp,
    ]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
