/**
 * @file createToken.js
 * @description Creates an NFT class on Hedera, defining it as a
 * non-fungible token with a custom royalty fee and role keys: the Umiña
 * class (stones, the default) or, with --token achala, the Achala class
 * (jewelry made of Umiña stones, umina-achala-chain#15). Both classes share
 * every setting except name, symbol and memo.
 *
 * Run from the command line:
 * node src/token/createToken.js [env-file] [--token umina|achala] [--dry-run]
 *
 * The network is NETWORK (testnet when unset, see src/network.js) and the env
 * file defaults to its own (.env.testnet); a file given must name the network.
 * --dry-run checks the environment and prints the token parameters without
 * keys and without touching the network.
 */

import {
  buildTokenTransaction,
  describeToken,
  loadKeys,
  parseCreateArgs,
  TOKEN_CLASSES,
  validateEnv,
} from "./lib.js";
import { envFileProblem, NETWORKS, networkName } from "../network.js";
import { fail, loadEnv, runScript } from "../script.js";

const input = parseCreateArgs(process.argv.slice(2));
const { tokenClass, dryRun } = input;
const envFile = input.envFile ?? NETWORKS[networkName()]?.envFile;
// Refuse a file meant for another network rather than send its credentials
// to the wrong one.
const fileProblem = input.problems.length || !envFile ? null : envFileProblem(envFile);
if (!input.problems.length && !fileProblem) loadEnv(envFile);

const USAGE = `Create an NFT token class with its royalty and role keys.

Usage: node src/token/createToken.js [env-file] [--token umina|achala] [--dry-run]

  [env-file]             default: the network's own; its name must name the network
  --token umina|achala   the class to create (default umina)`;

runScript(
  "Token creation failed",
  async (session) => {
    if (input.problems.length) return fail(input.problems);
    const tokenSettings = TOKEN_CLASSES[tokenClass];
    console.log(`🚀 Creating ${tokenSettings.name} NFT Class...`);
    if (fileProblem) return fail([fileProblem]);

    // --- 1. Check the environment ---
    const problems = validateEnv(process.env);
    if (problems.length) return fail(problems, `Problems in ${envFile}`);

    // --- 2. Load role keys and build the transaction ---
    const keys = loadKeys(process.env);
    const transaction = buildTokenTransaction(process.env, keys, tokenClass);

    if (dryRun) {
      console.log("Dry run, nothing sent:");
      console.log(describeToken(process.env, keys, tokenClass));
      return;
    }

    // --- 3. Connect to Hedera ---
    const client = session.connect();
    console.log(`Network: ${client.networkName}, Operator: ${process.env.OPERATOR_ID}`);

    // --- 4. Sign & Execute ---
    // The operator signs as fee payer when the transaction executes. The admin
    // key and, when it is a different account, the treasury key sign here.
    const frozen = transaction.freezeWith(client);
    await frozen.sign(keys.admin);
    if (keys.treasury) await frozen.sign(keys.treasury);
    const response = await frozen.execute(client);
    const receipt = await response.getReceipt(client);
    console.log("-----------------------------------");
    console.log(`✅ Success! ${tokenSettings.name} Token ID: ${receipt.tokenId}`);
    console.log("-----------------------------------");
    console.log(`SAVE THIS ID IN ${envFile} AS: ${tokenSettings.envVar}`);
  },
  {
    usage: USAGE,
    afterError: () =>
      console.error(`   Operator ${process.env.OPERATOR_ID}, treasury ${process.env.TREASURY_ID}`),
  },
);
