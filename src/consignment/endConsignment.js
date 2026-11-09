/**
 * @file endConsignment.js
 * @description Ends the consignment of an Umiña NFT serial on Hedera (NETWORK,
 * testnet by default) (umina-achala-chain#18): the merchant revokes UA's
 * allowance on the serial, and, unless --keep is given, sends the NFT back to
 * the Treasury. A return is recorded in HCS as TRANSFER with reason
 * "consignment_ended" (#10).
 *
 * Run from the command line:
 * node src/consignment/endConsignment.js <serial> [--keep] [--dry-run]
 *
 * --keep only revokes the allowance: the merchant keeps the NFT and UA can no
 * longer sell it. Ownership does not change, so no event is recorded; the
 * listing itself is a display topic matter (LISTED / UNLISTED, #10).
 *
 * The merchant must still hold the serial. The return carries no payment, so
 * no royalty applies; a fallback fee would be charged to the receiver, the
 * Treasury, which as fee collector is expected to be exempt (to verify on
 * testnet, umina-achala-documents/consignment.md).
 *
 * Testnet only: the merchant's key is read from .env.testnet to simulate the
 * merchant signing. In production the merchant signs in their own wallet.
 */

import {
  AccountAllowanceDeleteTransaction,
  AccountId,
  NftId,
  TokenId,
  TokenNftInfoQuery,
  TransferTransaction,
} from "@hashgraph/sdk";
import { consignmentProblems } from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { buildEvent, loadSubmitKey, submitEvent, submitKeyProblem } from "../hcs.js";
import { fail, loadEnv, parseScriptArgs, runScript } from "../script.js";

const args = parseScriptArgs({ "dry-run": { type: "boolean" }, keep: { type: "boolean" } }, 1);
const dryRun = Boolean(args.values["dry-run"]);
const keep = Boolean(args.values.keep);
const [serial] = args.positionals;
loadEnv();

const REQUIRED = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "TREASURY_ID",
  "UMINA_TOKEN_ID",
  "HCS_TOPIC_ID",
  "MERCHANT_ID",
  "MERCHANT_KEY",
];

let returnTxId;

const USAGE = `End a consignment: the merchant revokes UA's allowance and returns the NFT to
the Treasury, recorded as TRANSFER.

Usage: node src/consignment/endConsignment.js <serial> [--keep] [--dry-run]

  <serial>   the Umiña NFT serial
  --keep     only revoke the allowance; the merchant keeps the NFT`;

runScript("Ending the consignment failed", async (session) => {
  // --- 1. Check the arguments and environment ---
  if (args.problems.length) return fail(args.problems);
  const problems = consignmentProblems(process.env, REQUIRED, serial);
  const submitProblem = submitKeyProblem(process.env);
  if (submitProblem) problems.push(submitProblem);
  if (problems.length) return fail(problems);

  const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
  const treasuryId = AccountId.fromString(process.env.TREASURY_ID);
  const merchantId = AccountId.fromString(process.env.MERCHANT_ID);
  const tokenId = TokenId.fromString(process.env.UMINA_TOKEN_ID);
  const nftId = new NftId(tokenId, Number(serial));
  const merchantKey = parseEcdsaKey(process.env.MERCHANT_KEY);

  if (dryRun) {
    console.log(`Would revoke ${operatorId}'s allowance on ${nftId} for ${merchantId}`);
    if (keep) {
      console.log(`Would leave ${nftId} with ${merchantId} (--keep); no event recorded`);
    } else {
      console.log(`Would return ${nftId} from ${merchantId} to ${treasuryId}`);
      console.log(`Would record TRANSFER (consignment_ended) in ${process.env.HCS_TOPIC_ID}`);
    }
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 2. Connect to Hedera (UA pays the fees) ---
  const client = session.connect();

  // --- 3. Check the merchant still holds the serial ---
  const [info] = await new TokenNftInfoQuery().setNftId(nftId).execute(client);
  if (info.accountId.toString() !== merchantId.toString()) {
    console.error(
      `❌ ${nftId} is held by ${info.accountId}, not the merchant ${merchantId}. Nothing to end.`,
    );
    process.exitCode = 1;
    return;
  }

  // --- 4. Merchant revokes UA's allowance on this serial (merchant signs) ---
  const revokeTx = await new AccountAllowanceDeleteTransaction()
    .deleteAllTokenNftAllowances(nftId, merchantId)
    .freezeWith(client)
    .sign(merchantKey);
  const revokeResponse = await revokeTx.execute(client);
  const revokeReceipt = await revokeResponse.getReceipt(client);
  console.log(`✅ ${operatorId} may no longer sell ${nftId}: ${revokeReceipt.status}`);

  if (keep) {
    console.log(`ℹ️  ${nftId} stays with ${merchantId} (--keep); ownership did not change, no event recorded.`);
    return;
  }

  // --- 5. Merchant returns the NFT to the Treasury (merchant signs) ---
  const returnTx = await new TransferTransaction()
    .addNftTransfer(nftId, merchantId, treasuryId)
    .freezeWith(client)
    .sign(merchantKey);
  const returnResponse = await returnTx.execute(client);
  const returnReceipt = await returnResponse.getReceipt(client);
  returnTxId = returnResponse.transactionId.toString();
  console.log(`✅ ${nftId} returned to ${treasuryId}: ${returnReceipt.status} (${returnTxId})`);

  // --- 6. Record the return in HCS ---
  const message = buildEvent(
    { event: "TRANSFER", tokenId, serials: [serial], actorId: operatorId, ref: returnTxId },
    {
      from_id: merchantId.toString(),
      to_id: treasuryId.toString(),
      reason: "consignment_ended",
    },
  );
  const hcsTxId = await submitEvent(
    client,
    process.env.HCS_TOPIC_ID,
    message,
    loadSubmitKey(process.env),
  );
  console.log(`✅ TRANSFER recorded: ${hcsTxId}`);
}, {
  usage: USAGE,
  afterError: () => {
    if (returnTxId) {
      console.error(
        `   The NFT already went back to the Treasury in ${returnTxId}, but TRANSFER was not recorded.`,
      );
    }
  },
});
