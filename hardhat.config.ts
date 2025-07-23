import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@typechain/hardhat"; // ✅ TypeChain plugin

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28", // Your current Solidity version
    settings: {
      optimizer: {
        enabled: true, // Enable the optimizer
        runs: 200, // Optimize for 200 runs (common value for deployment cost)
      },
      // You can also specify the EVM version if targeting a specific chain, e.g.:
      evmVersion: "paris", // or "london", "shanghai" etc.
    },
  },
  typechain: {
    outDir: "typechain-types", // ✅ Match this to your import paths
    target: "ethers-v6", // ✅ Required for Ethers v6 support
  },
};

export default config;
