/**
 * @file associateToken.js
 * @description Associates the Umiña token with a merchant or buyer test
 * account on Hedera TESTNET. An account must associate a token before it can
 * receive one of its NFTs: the buyer before sellConsigned.js, the merchant
 * before consignToMerchant.js (which also does it for the merchant).
 *
 * Run from the command line:
 * node src/consignment/associateToken.js <merchant|buyer> [--dry-run]
 *
 * Uses <ROLE>_ID and <ROLE>_KEY from .env.testnet; the account's key signs and
 * UA (the operator) pays the fee. Testnet only: in production the account
 * associates the token in its own wallet.
 */

import dotenv from "dotenv";
import { AccountId, Client, TokenId } from "@hashgraph/sdk";
import { associateToken, roleProblems, ROLES } from "./lib.js";
import { parseEcdsaKey } from "../keys.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const role = args.find((a) => !a.startsWith("--"));
dotenv.config({ path: ".env.testnet" });

async function main() {
  let client;
  try {
    // --- 1. Check the role and environment ---
    const problems = roleProblems(process.env, role);
    if (problems.length) {
      console.error("❌ Problems found:");
      problems.forEach((p) => console.error(`   - ${p}`));
      process.exitCode = 1;
      return;
    }

    const prefix = ROLES[role];
    const accountId = AccountId.fromString(process.env[`${prefix}_ID`]);
    const accountKey = parseEcdsaKey(process.env[`${prefix}_KEY`]);
    const tokenId = TokenId.fromString(process.env.UMINA_TOKEN_ID);

    if (dryRun) {
      console.log(`Would associate ${tokenId} with ${role} ${accountId}`);
      console.log("Dry run, nothing sent.");
      return;
    }

    // --- 2. Connect to Hedera testnet (UA pays the fee) ---
    client = Client.forTestnet().setOperator(
      AccountId.fromString(process.env.OPERATOR_ID),
      parseEcdsaKey(process.env.OPERATOR_KEY),
    );

    // --- 3. Associate (the account signs) ---
    const associated = await associateToken(client, accountId, accountKey, tokenId);
    console.log(
      associated
        ? `✅ ${role} ${accountId} associated ${tokenId}`
        : `ℹ️  ${role} ${accountId} already associated ${tokenId}`,
    );
  } catch (err) {
    console.error("❌ Association failed:", err);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

main();
