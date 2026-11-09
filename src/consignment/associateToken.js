/**
 * @file associateToken.js
 * @description Associates a token (Umiña by default, Achala with --token
 * achala) with a merchant or buyer test account on Hedera (NETWORK, testnet by
 * default). An account must associate a token before it can receive one of its
 * NFTs: the buyer before sellConsigned.js or sellOwnItem.js, the merchant
 * before consignToMerchant.js (which also does it for the merchant). The buyer
 * of an Achala receives its Umiña stones too, so associates both tokens
 * (umina-achala-chain#26).
 *
 * Run from the command line:
 * node src/consignment/associateToken.js <merchant|buyer> [--token umina|achala] [--dry-run]
 *
 * Uses <ROLE>_ID and <ROLE>_KEY from the env file; the account's key signs and
 * UA (the operator) pays the fee. Testnet only: in production the account
 * associates the token in its own wallet.
 */

import { parseArgs } from "util";
import { AccountId, TokenId } from "@hashgraph/sdk";
import { associateToken, roleProblems, ROLES } from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";
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
  argProblem = tokenClassProblem(tokenClass);
} catch (err) {
  argProblem = err.message;
}
loadEnv();

runScript("Association failed", async (session) => {
  // --- 1. Check the role and environment ---
  const problems = argProblem ? [argProblem] : roleProblems(process.env, role, tokenClass);
  if (problems.length) return fail(problems);

  const prefix = ROLES[role];
  const accountId = AccountId.fromString(process.env[`${prefix}_ID`]);
  const accountKey = parseEcdsaKey(process.env[`${prefix}_KEY`]);
  const tokenId = TokenId.fromString(process.env[TOKEN_CLASSES[tokenClass].envVar]);

  if (dryRun) {
    console.log(`Would associate ${tokenId} with ${role} ${accountId}`);
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 2. Connect to Hedera (UA pays the fee) ---
  const client = session.connect();

  // --- 3. Associate (the account signs) ---
  const associated = await associateToken(client, accountId, accountKey, tokenId);
  console.log(
    associated
      ? `✅ ${role} ${accountId} associated ${tokenId}`
      : `ℹ️  ${role} ${accountId} already associated ${tokenId}`,
  );
});
