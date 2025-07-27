/**
 * @file stress-test.ts
 * @author ZoopX Labs
 * @date 2025-07-25
 *
 * @description This script performs a stress test on the deployed protocol by running the
 * end-to-end user journey (deposit, add liquidity, swap) multiple times in a loop.
 *
 * To run: npx hardhat run scripts/stress-test.ts --network qubeticsTestnet
 */

import { ethers } from "hardhat";
import { expect } from "chai"; // Added for validation checks
// Corrected imports for a two-repo setup
import {
  ZoopXRouter,
  ZoopXFactory,
  WTICS,
  IZoopXPair,
} from "../../amm/typechain-types";
import { TICS_Staking_Vault, ZTICS } from "../typechain-types";

// --- CONFIGURATION ---
const addresses = {
  TICS_STAKING_VAULT: "0x30387663976F174f78A5a1c10249240B32592f25",
  ZTICS: "0xaaC4F62b5125418E300DB6FEB2c8a93fAa3C197b",
  ZOOPX_ROUTER: "0x49bB38e98A1742F1664705de4171baD2e5ceb6a6",
  ZOOPX_FACTORY: "0x3e0777DcE14cC513233bF0cA8Dd0179186bee994",
  WTICS: "0x3e8b23066d8b26CD5dC904B70B3cb2Fd163bF688",
};

// --- STRESS TEST PARAMETERS ---
const NUMBER_OF_RUNS = 10; // Number of times to run the full cycle
const TICS_TO_STAKE_PER_RUN = ethers.parseEther("0.1"); // Use smaller amounts for loops
const TICS_FOR_LIQUIDITY_PER_RUN = ethers.parseEther("0.05");
const TICS_TO_SWAP_PER_RUN = ethers.parseEther("0.01");

async function main() {
  const [user] = await ethers.getSigners();
  console.log(`Starting stress test with account: ${user.address}`);
  let initialBalance = await ethers.provider.getBalance(user.address);
  console.log(
    `Initial account balance: ${ethers.formatEther(initialBalance)} TICS`
  );

  // --- Get Contract Instances ---
  const ticsVault = (await ethers.getContractAt(
    "TICS_Staking_Vault",
    addresses.TICS_STAKING_VAULT
  )) as unknown as TICS_Staking_Vault;
  const zTICS = (await ethers.getContractAt(
    "zTICS",
    addresses.ZTICS
  )) as unknown as ZTICS;
  const router = (await ethers.getContractAt(
    "ZoopXRouter",
    addresses.ZOOPX_ROUTER
  )) as unknown as ZoopXRouter;
  const factory = (await ethers.getContractAt(
    "ZoopXFactory",
    addresses.ZOOPX_FACTORY
  )) as unknown as ZoopXFactory;

  // --- Initial Liquidity Check ---
  const pairAddress = await factory.getPair(addresses.WTICS, addresses.ZTICS);
  if (pairAddress === ethers.ZeroAddress) {
    console.log(
      "No TICS/zTICS pair found. Performing initial liquidity provision..."
    );
    // Initial setup to ensure the pool exists
    const initialStake = ethers.parseEther("1.0");
    const initialLP = ethers.parseEther("0.5");
    await (await ticsVault.deposit(0, { value: initialStake })).wait();
    const initialZtics = await zTICS.balanceOf(user.address);
    await (await zTICS.approve(addresses.ZOOPX_ROUTER, initialZtics)).wait();
    const deadline =
      (await ethers.provider.getBlock("latest"))!.timestamp + 120;
    await (
      await router.addLiquidityTICS(
        addresses.ZTICS,
        initialZtics,
        0,
        0,
        user.address,
        deadline,
        { value: initialLP }
      )
    ).wait();
    console.log("Initial liquidity provided.");
  } else {
    console.log(`TICS/zTICS pair already exists at: ${pairAddress}`);
  }

  // --- Stress Test Loop ---
  for (let i = 0; i < NUMBER_OF_RUNS; i++) {
    console.log(`\n--- 🔁 RUN ${i + 1} of ${NUMBER_OF_RUNS} ---`);

    try {
      // 1. Deposit TICS for zTICS
      console.log(
        `   Depositing ${ethers.formatEther(TICS_TO_STAKE_PER_RUN)} TICS...`
      );
      const depositTx = await ticsVault.deposit(0, {
        value: TICS_TO_STAKE_PER_RUN,
      });
      await depositTx.wait(1);
      const mintedZTICS = await zTICS.balanceOf(user.address);

      // 2. Add Liquidity
      console.log(
        `   Adding liquidity with ${ethers.formatEther(
          TICS_FOR_LIQUIDITY_PER_RUN
        )} TICS...`
      );
      await (await zTICS.approve(addresses.ZOOPX_ROUTER, mintedZTICS)).wait(1);
      const deadline =
        (await ethers.provider.getBlock("latest"))!.timestamp + 120;
      const addLiquidityTx = await router.addLiquidityTICS(
        addresses.ZTICS,
        mintedZTICS,
        0,
        0,
        user.address,
        deadline,
        { value: TICS_FOR_LIQUIDITY_PER_RUN }
      );
      await addLiquidityTx.wait(1);

      // 3. Swap
      console.log(
        `   Swapping ${ethers.formatEther(
          TICS_TO_SWAP_PER_RUN
        )} TICS for zTICS...`
      );
      const swapTx = await router.swapExactTICSForTokens(
        0,
        [addresses.WTICS, addresses.ZTICS],
        user.address,
        (await ethers.provider.getBlock("latest"))!.timestamp + 120,
        { value: TICS_TO_SWAP_PER_RUN }
      );
      await swapTx.wait(1);

      console.log(`   ✅ Run ${i + 1} completed successfully.`);
    } catch (error) {
      console.error(`   ❌ Run ${i + 1} failed!`);
      console.error(error);
      // Decide if you want to stop on failure or continue
      break;
    }
  }

  let finalBalance = await ethers.provider.getBalance(user.address);
  console.log(`\n--- ✅ STRESS TEST COMPLETE ---`);
  console.log(`Initial Balance: ${ethers.formatEther(initialBalance)} TICS`);
  console.log(`Final Balance:   ${ethers.formatEther(finalBalance)} TICS`);
  console.log(
    `TICS spent on gas and transactions: ${ethers.formatEther(
      initialBalance - finalBalance
    )}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
