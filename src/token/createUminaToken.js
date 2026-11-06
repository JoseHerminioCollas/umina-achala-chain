/**
 * @file createUminaToken.js
 * @description Creates an NFT class on Hedera TESTNET, defining it as a
 * non-fungible token with a custom royalty fee and role keys: the Umiña
 * class (stones, the default) or, with --token achala, the Achala class
 * (jewelry set with Umiña stones, umina-achala-chain#15). Both classes share
 * every setting except name, symbol and memo.
 *
 * Run from the command line:
 * node src/token/createUminaToken.js [env-file] [--token umina|achala] [--dry-run]
 *
 * The env file defaults to .env.testnet. --dry-run checks the environment and
 * prints the token parameters without keys and without touching the network.
 * Never run this against mainnet from this script.
 */

import dotenv from "dotenv";
import path from "path";
import { Client } from "@hashgraph/sdk";
import {
  buildTokenTransaction,
  describeToken,
  loadKeys,
  TOKEN_CLASSES,
  validateEnv,
} from "./lib.js";
import { parseEcdsaKey } from "../keys.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tokenIndex = args.indexOf("--token");
const tokenClass = tokenIndex === -1 ? "umina" : args[tokenIndex + 1];
const envFile =
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--token") ?? ".env.testnet";
// The client below is always testnet, so refuse a file meant for another
// network rather than send its credentials to the wrong one.
const testnetOnly = path.basename(envFile).includes("testnet");
if (testnetOnly) dotenv.config({ path: envFile });

async function main() {
  const tokenSettings = TOKEN_CLASSES[tokenClass];
  if (!tokenSettings) {
    console.error(`❌ --token must be ${Object.keys(TOKEN_CLASSES).join(" or ")}, got "${tokenClass}"`);
    process.exitCode = 1;
    return;
  }
  console.log(`🚀 Creating ${tokenSettings.name} NFT Class...`);

  if (!testnetOnly) {
    console.error(
      `❌ ${envFile} is not a testnet env file. This script is testnet only; mainnet support is not built yet.`,
    );
    process.exitCode = 1;
    return;
  }

  // --- 1. Check the environment ---
  const problems = validateEnv(process.env);
  if (problems.length) {
    console.error(`❌ Problems in ${envFile}:`);
    problems.forEach((p) => console.error(`   - ${p}`));
    process.exitCode = 1;
    return;
  }

  // --- 2. Load role keys and build the transaction ---
  const keys = loadKeys(process.env);
  const transaction = buildTokenTransaction(process.env, keys, tokenClass);

  if (dryRun) {
    console.log("Dry run, nothing sent:");
    console.log(describeToken(process.env, keys, tokenClass));
    return;
  }

  // --- 3. Connect to Hedera testnet ---
  const operatorId = process.env.OPERATOR_ID;
  const client = Client.forTestnet().setOperator(
    operatorId,
    parseEcdsaKey(process.env.OPERATOR_KEY),
  );
  console.log(`Network: ${client.networkName}, Operator: ${operatorId}`);

  // --- 4. Sign & Execute ---
  // The operator signs as fee payer when the transaction executes. The admin
  // key and, when it is a different account, the treasury key sign here.
  try {
    const frozen = await transaction.freezeWith(client);
    await frozen.sign(keys.admin);
    if (keys.treasury) await frozen.sign(keys.treasury);
    const response = await frozen.execute(client);
    const receipt = await response.getReceipt(client);
    console.log("-----------------------------------");
    console.log(`✅ Success! ${tokenSettings.name} Token ID: ${receipt.tokenId}`);
    console.log("-----------------------------------");
    console.log(`SAVE THIS ID IN ${envFile} AS: ${tokenSettings.envVar}`);
  } catch (err) {
    console.error("❌ Token creation failed:", err, {
      operatorId,
      treasuryAccountId: process.env.TREASURY_ID,
    });
    process.exitCode = 1;
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
