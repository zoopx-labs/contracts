// scripts/flatten-contracts.ts
import { run } from "hardhat"; // glob is not directly from hardhat, will use fs instead
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("--- Starting Contract Flattening ---");

  const contractsDir = path.join(__dirname, "../contracts");
  const flattenedDir = path.join(__dirname, "../flattened");

  // Create the 'flattened' directory if it doesn't exist
  if (!fs.existsSync(flattenedDir)) {
    fs.mkdirSync(flattenedDir);
    console.log(`Created directory: ${flattenedDir}`);
  } else {
    // Optionally clear existing flattened files
    fs.readdirSync(flattenedDir).forEach((file) => {
      fs.unlinkSync(path.join(flattenedDir, file));
    });
    console.log(`Cleared existing files in: ${flattenedDir}`);
  }

  // Find all Solidity files in the contracts directory
  // Using fs.readdirSync to list files and filter for .sol extension
  const solidityFiles: string[] = fs
    .readdirSync(contractsDir)
    .filter((file) => file.endsWith(".sol"))
    .map((file) => path.join(contractsDir, file)); // Get full path

  if (solidityFiles.length === 0) {
    console.warn("No Solidity files found in the 'contracts' directory.");
    return;
  }

  for (const filePath of solidityFiles) {
    const contractName = path.basename(filePath, ".sol");
    const outputPath = path.join(flattenedDir, `${contractName}_flattened.sol`);
    const relativePath = path.relative(path.join(__dirname, ".."), filePath); // Get path relative to project root

    console.log(`\nFlattening ${contractName} (${relativePath})...`);

    try {
      // Run the 'flatten' task for each contract
      const flattenedCode = await run("flatten", {
        // The 'flatten' task expects the path relative to the Hardhat project root
        // So, we need to adjust the filePath accordingly
        // Example: contracts/MyContract.sol
        contract: relativePath,
      });

      // Write the flattened code to a new file
      fs.writeFileSync(outputPath, flattenedCode);
      console.log(`✅ Successfully flattened ${contractName} to ${outputPath}`);
    } catch (error: any) {
      // Log the specific error message from Hardhat's flatten task
      console.error(`❌ Failed to flatten ${contractName}: ${error.message}`);
      // Optionally, you might want to re-throw the error if you want the script to stop on first failure
      // throw error;
    }
  }

  console.log("\n--- Contract Flattening Complete ---");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
