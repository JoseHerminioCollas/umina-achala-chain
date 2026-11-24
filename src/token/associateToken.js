/**
 * @file associateToken.js
 * @description Associates the Umiña token, or with --token achala both the
 * Achala and the Umiña tokens, with a merchant or buyer test account on
 * Hedera (NETWORK, required). An account must associate a token before it can
 * receive one of its NFTs: the buyer before sellConsigned.js or
 * sellOwnItem.js, the merchant before consignToMerchant.js (which also does it
 * for the merchant). An Achala moves with its Umiña stones, so --token achala
 * associates both tokens (umina-achala-chain#26, #28); a token already
 * associated is skipped.
 *
 * Run from the command line, with NETWORK set (testnet or mainnet; it has no
 * default and the script refuses to run without it, see src/network.js):
 * NETWORK=testnet node src/consignment/associateToken.js <merchant|buyer> [--token umina|achala] [--dry-run]
 *
 * Uses <ROLE>_ID and <ROLE>_KEY from the env file; the account's key signs and
 * UA (the operator) pays the fee. Testnet only: in production the account
 * associates the token in its own wallet.
 */

import { parseArgs } from "util";
import { AccountId, TokenId } from "@hashgraph/sdk";
import { associateToken, roleProblems, ROLES, tokenVars } from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { tokenClassProblem } from "../token/lib.js";
import { fail, loadEnv, runScript } from "../script.js";

let role, dryRun, tokenClass, argProblem;
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { "dry-run": { type: "boolean" }, token: { type: "string" } },
    allowPositionals: true,
  });
  [role] = positionals;
  dryRun = Boolean(values["dry-run"]);
  tokenClass = values.token ?? "umina";
  argProblem =
    positionals.length > 1 ? `too many arguments: ${positionals.slice(1).join(" ")}` : tokenClassProblem(tokenClass);
} catch (err) {
  argProblem = err.message;
}
loadEnv();

const USAGE = `Associate a token with the merchant or buyer test account, so it can receive NFTs.

Usage: NETWORK=testnet node src/consignment/associateToken.js <merchant|buyer> [--token umina|achala] [--dry-run]

  <merchant|buyer>       the account: MERCHANT_ID/KEY or BUYER_ID/KEY
  --token umina|achala   umina (default) associates the Umiña token; achala
                         associates both, since an Achala moves with its stones`;

// Exported so tests can wait for the run to finish
export const done = runScript("Association failed", async (session) => {
  // --- 1. Check the role and environment ---
  const problems = argProblem ? [argProblem] : roleProblems(process.env, role, tokenClass);
  if (problems.length) return fail(problems);

  const prefix = ROLES[role];
  const accountId = AccountId.fromString(process.env[`${prefix}_ID`]);
  const accountKey = parseEcdsaKey(process.env[`${prefix}_KEY`]);
  const tokenIds = tokenVars(tokenClass).map((name) => TokenId.fromString(process.env[name]));

  if (dryRun) {
    tokenIds.forEach((id) => console.log(`Would associate ${id} with ${role} ${accountId}`));
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 2. Connect to Hedera (UA pays the fee) ---
  const client = session.connect();

  // --- 3. Associate each token (the account signs) ---
  for (const tokenId of tokenIds) {
    const associated = await associateToken(client, accountId, accountKey, tokenId);
    console.log(
      associated
        ? `✅ ${role} ${accountId} associated ${tokenId}`
        : `ℹ️  ${role} ${accountId} already associated ${tokenId}`,
    );
  }
}, { usage: USAGE });
