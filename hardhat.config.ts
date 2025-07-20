import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@typechain/hardhat"; // ✅ TypeChain plugin

const config: HardhatUserConfig = {
  solidity: "0.8.28",
  typechain: {
    outDir: "typechain-types", // ✅ Match this to your import paths
    target: "ethers-v6", // ✅ Required for Ethers v6 support
  },
};

export default config;
