/**
 * @file endConsignment.js
 * @description Ends the consignment of an Umiña NFT serial, or with --token
 * achala of an Achala with every Umiña stone in it, on Hedera (NETWORK,
 * required) (umina-achala-chain#18, #28): the merchant revokes UA's allowance
 * on the NFT(s), and, unless --keep is given, sends them back to the Treasury
 * in one transfer. A return is recorded in HCS as one TRANSFER with reason
 * "consignment_ended" (#10).
 *
 * Run from the command line, with NETWORK set (testnet or mainnet; it has no
 * default and the script refuses to run without it, see src/network.js):
 * NETWORK=testnet node src/consignment/endConsignment.js <serial> [--token umina|achala] [--keep] [--dry-run]
 *
 * --keep only revokes the allowance: the merchant keeps the NFT(s) and UA can
 * no longer sell them. Ownership does not change, so no event is recorded;
 * the listing itself is a display topic matter (LISTED / UNLISTED, #10).
 *
 * An Umiña mounted in an Achala that still exists is refused: its
 * consignment ends only with its Achala's (#24). The merchant must still hold
 * every NFT. The provenance topic and the holders (mirror node) are read
 * first, also on --dry-run.
 *
 * The return carries no payment, so no royalty applies; a fallback fee would
 * be charged to the receiver, the Treasury, which as fee collector is
 * expected to be exempt (to verify on testnet, umina-achala-documents/
 * consignment.md).
 *
 * Testnet only: the merchant's key is read from .env.testnet to simulate the
 * merchant signing. In production the merchant signs in their own wallet.
 */

import { AccountAllowanceDeleteTransaction, AccountId, TokenId, TransferTransaction } from "@hashgraph/sdk";
import { consignmentNfts, consignmentProblems, tokenVars } from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { buildEvent, loadSubmitKey, submitEvent, submitKeyProblem } from "../hcs.js";
import { readProvenance } from "../provenance.js";
import { holderProblems, readHolders } from "../nfts.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";
import { fail, loadEnv, parseScriptArgs, runScript } from "../script.js";

const args = parseScriptArgs(
  { "dry-run": { type: "boolean" }, keep: { type: "boolean" }, token: { type: "string" } },
  1,
);
const dryRun = Boolean(args.values["dry-run"]);
const keep = Boolean(args.values.keep);
const tokenClass = args.values.token ?? "umina";
const [serial] = args.positionals;
loadEnv();

const REQUIRED = ["OPERATOR_ID", "OPERATOR_KEY", "TREASURY_ID", "HCS_TOPIC_ID", "MERCHANT_ID", "MERCHANT_KEY"];

let returnTxId;
let nfts;

const USAGE = `End a consignment: the merchant revokes UA's allowance and returns the NFT(s)
to the Treasury, recorded as TRANSFER. An Achala ends with its stones.

Usage: NETWORK=testnet node src/consignment/endConsignment.js <serial> [--token umina|achala] [--keep] [--dry-run]

  <serial>               the NFT serial in the class's token
  --token umina|achala   the token class (default umina); an Achala moves with its stones
  --keep                 only revoke the allowance; the merchant keeps the NFT(s)`;

// Exported so tests can wait for the run to finish
export const done = runScript("Ending the consignment failed", async (session) => {
  // --- 1. Check the arguments and environment ---
  if (args.problems.length) return fail(args.problems);
  const classProblem = tokenClassProblem(tokenClass);
  if (classProblem) return fail([classProblem]);
  const problems = consignmentProblems(process.env, [...REQUIRED, ...tokenVars(tokenClass)], serial);
  const submitProblem = submitKeyProblem(process.env);
  if (submitProblem) problems.push(submitProblem);
  if (problems.length) return fail(problems);

  const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
  const treasuryId = AccountId.fromString(process.env.TREASURY_ID);
  const merchantId = AccountId.fromString(process.env.MERCHANT_ID);
  const tokenId = TokenId.fromString(process.env[TOKEN_CLASSES[tokenClass].envVar]);
  const merchantKey = parseEcdsaKey(process.env.MERCHANT_KEY);

  // --- 2. What moves, from the provenance topic (#24, #28), and the merchant still holds it ---
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
  const plan = consignmentNfts(events, process.env, serial, tokenClass);
  if (plan.problems.length) return fail(plan.problems);
  const { nftIds } = plan;
  nfts = nftIds.join(", ");
  const held = holderProblems(nftIds, await readHolders(nftIds), merchantId.toString(), {
    holder: "the merchant",
    then: "Nothing to end.",
  });
  if (held.length) return fail(held);

  if (dryRun) {
    console.log(`Would revoke ${operatorId}'s allowance on ${nfts} for ${merchantId}`);
    if (keep) {
      console.log(`Would leave ${nfts} with ${merchantId} (--keep); no event recorded`);
    } else {
      console.log(`Would return ${nfts} from ${merchantId} to ${treasuryId}`);
      console.log(`Would record TRANSFER (consignment_ended) in ${process.env.HCS_TOPIC_ID}`);
    }
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 3. Connect to Hedera (UA pays the fees) ---
  const client = session.connect();

  // --- 4. Merchant revokes UA's allowance on each NFT (merchant signs) ---
  const revoke = new AccountAllowanceDeleteTransaction();
  nftIds.forEach((id) => revoke.deleteAllTokenNftAllowances(id, merchantId));
  const revokeTx = await revoke.freezeWith(client).sign(merchantKey);
  const revokeResponse = await revokeTx.execute(client);
  const revokeReceipt = await revokeResponse.getReceipt(client);
  console.log(`✅ ${operatorId} may no longer sell ${nfts}: ${revokeReceipt.status}`);

  if (keep) {
    console.log(`ℹ️  ${nfts} stays with ${merchantId} (--keep); ownership did not change, no event recorded.`);
    return;
  }

  // --- 5. Merchant returns the NFT(s) to the Treasury, in one transfer (merchant signs) ---
  const back = new TransferTransaction();
  nftIds.forEach((id) => back.addNftTransfer(id, merchantId, treasuryId));
  const returnTx = await back.freezeWith(client).sign(merchantKey);
  const returnResponse = await returnTx.execute(client);
  const returnReceipt = await returnResponse.getReceipt(client);
  returnTxId = returnResponse.transactionId.toString();
  console.log(`✅ ${nfts} returned to ${treasuryId}: ${returnReceipt.status} (${returnTxId})`);

  // --- 6. Record the return in HCS: one event for a piece and its stones ---
  const message = buildEvent(
    {
      event: "TRANSFER",
      tokenId,
      serials: [serial],
      actorId: operatorId,
      ref: returnTxId,
      ...(plan.stoneId && { stoneId: plan.stoneId }),
    },
    {
      from_id: merchantId.toString(),
      to_id: treasuryId.toString(),
      reason: "consignment_ended",
      ...plan.fields,
    },
  );
  const hcsTxId = await submitEvent(client, process.env.HCS_TOPIC_ID, message, loadSubmitKey(process.env));
  console.log(`✅ TRANSFER recorded: ${hcsTxId}`);
}, {
  usage: USAGE,
  afterError: () => {
    if (returnTxId) {
      console.error(
        `   ${nfts} already went back to the Treasury in ${returnTxId}, but TRANSFER was not recorded.`,
      );
    }
  },
});
