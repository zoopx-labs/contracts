import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config"; // Import dotenv to read .env file

// Ensure environment variables are set
const qubeticsRpcUrl = process.env.QUBETICS_TESTNET_RPC_URL;
if (!qubeticsRpcUrl) {
  console.error("QUBETICS_TESTNET_RPC_URL is not set in .env file");
}

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  console.error("PRIVATE_KEY is not set in .env file");
}

const config: HardhatUserConfig = {
  solidity: {
    // Standardizing to 0.8.20 to match your contracts
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {}, // Default local network
    qubeticsTestnet: {
      url: qubeticsRpcUrl || "",
      accounts: privateKey ? [privateKey] : [],
      chainId: 9029,
    },
  },
  etherscan: {
    // This is for contract verification. You may need to get an API key
    // from the Qubetics block explorer if they provide one.
    apiKey: {
      // apiKey is not needed for Etherscan-like explorers on custom networks
      qubeticsTestnet: "no-api-key-needed",
    },
    customChains: [
      {
        network: "qubeticsTestnet",
        chainId: 9029,
        urls: {
          apiURL: "https://rpc-testnet.qubetics.work/", // URL for the block explorer's API
          browserURL: "https://testnet.qubetics.work", // URL of the block explorer
        },
      },
    ],
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
