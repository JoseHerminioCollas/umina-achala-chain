/**
 * @file consignToMerchant.js
 * @description Consigns a minted Umiña NFT serial, or with --token achala an
 * Achala with every Umiña stone in it, to a merchant on Hedera (NETWORK,
 * required): the merchant associates the token(s), the treasury transfers the
 * NFT(s) to the merchant in one transfer, the merchant grants UA (the
 * operator account) an NFT allowance on each so UA can sell them, and the
 * transfer is recorded in HCS as one ISSUED_TO_OWNER (umina-achala-chain#10,
 * #18, #28).
 *
 * Run from the command line, with NETWORK set (testnet or mainnet; it has no
 * default and the script refuses to run without it, see src/network.js):
 * NETWORK=testnet node src/consignment/consignToMerchant.js <serial> [--token umina|achala] [--dry-run]
 *
 * An Umiña mounted in an Achala that still exists is refused: it moves only
 * with its Achala (umina-achala-chain#24). An Achala moves with the stones
 * its MINT lists (at most 9, one transfer of 10 NFTs). The provenance topic
 * and the holders (mirror node) are read first, also on --dry-run.
 *
 * The event is recorded only after the transfer and the allowance have both
 * succeeded. If a step fails after the NFTs have moved, the script says what
 * already happened on the ledger, so it can be finished or recorded by hand.
 *
 * Testnet only: the merchant's key is read from .env.testnet to simulate the
 * merchant signing. In production the merchant signs in their own wallet.
 */

import { AccountAllowanceApproveTransaction, AccountId, TokenId, TransferTransaction } from "@hashgraph/sdk";
import { associateToken, consignmentNfts, consignmentProblems, tokenVars } from "./lib.js";
import { parseEcdsaKey, treasuryKeyProblem } from "../keys.js";
import { buildEvent, loadSubmitKey, submitEvent, submitKeyProblem } from "../hcs.js";
import { readProvenance } from "../provenance.js";
import { holderProblems, readHolders } from "../nfts.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";
import { fail, loadEnv, parseScriptArgs, runScript } from "../script.js";

const args = parseScriptArgs({ "dry-run": { type: "boolean" }, token: { type: "string" } }, 1);
const dryRun = Boolean(args.values["dry-run"]);
const tokenClass = args.values.token ?? "umina";
const [serial] = args.positionals;
loadEnv();

const REQUIRED = ["OPERATOR_ID", "OPERATOR_KEY", "TREASURY_ID", "HCS_TOPIC_ID", "MERCHANT_ID", "MERCHANT_KEY"];

let transferTxId;
let moving;

const USAGE = `Consign an Umiña serial, or an Achala with its stones, to the merchant: the
merchant associates the token(s), the Treasury sends the NFT(s), the merchant
gives UA an allowance on each, and ISSUED_TO_OWNER is recorded. A stone
mounted in an Achala is refused on its own.

Usage: NETWORK=testnet node src/consignment/consignToMerchant.js <serial> [--token umina|achala] [--dry-run]

  <serial>               the NFT serial in the class's token
  --token umina|achala   the token class (default umina); an Achala moves with its stones`;

// Exported so tests can wait for the run to finish
export const done = runScript("Consignment failed", async (session) => {
  // --- 1. Check the arguments and environment ---
  if (args.problems.length) return fail(args.problems);
  const classProblem = tokenClassProblem(tokenClass);
  if (classProblem) return fail([classProblem]);
  const problems = consignmentProblems(process.env, [...REQUIRED, ...tokenVars(tokenClass)], serial);
  for (const problem of [treasuryKeyProblem(process.env), submitKeyProblem(process.env)]) {
    if (problem) problems.push(problem);
  }
  if (problems.length) return fail(problems);

  const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
  const treasuryId = AccountId.fromString(process.env.TREASURY_ID);
  const merchantId = AccountId.fromString(process.env.MERCHANT_ID);
  const tokenId = TokenId.fromString(process.env[TOKEN_CLASSES[tokenClass].envVar]);
  const tokenIds = tokenVars(tokenClass).map((name) => TokenId.fromString(process.env[name]));
  const merchantKey = parseEcdsaKey(process.env.MERCHANT_KEY);
  const treasuryKey = process.env.TREASURY_KEY ? parseEcdsaKey(process.env.TREASURY_KEY) : null;

  // --- 2. What moves, from the provenance topic: a stone alone only when it
  // is not in an Achala (#24); an Achala with its stones (#28) ---
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
  const plan = consignmentNfts(events, process.env, serial, tokenClass);
  if (plan.problems.length) return fail(plan.problems);
  const { nftIds } = plan;
  moving = nftIds.join(", ");
  const held = holderProblems(nftIds, await readHolders(nftIds), treasuryId.toString());
  if (held.length) return fail(held);

  if (dryRun) {
    tokenIds.forEach((id) => console.log(`Would associate ${id} with ${merchantId}`));
    console.log(`Would transfer ${nftIds.join(", ")} from ${treasuryId} to ${merchantId}`);
    console.log(`Would approve ${operatorId} to sell ${nftIds.join(", ")} for ${merchantId}`);
    console.log(`Would record ISSUED_TO_OWNER to ${merchantId} in ${process.env.HCS_TOPIC_ID}`);
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 3. Connect to Hedera (UA pays the fees) ---
  const client = session.connect();

  // --- 4. Merchant associates the token(s) (merchant signs) ---
  for (const id of tokenIds) {
    const associated = await associateToken(client, merchantId, merchantKey, id);
    console.log(associated ? `✅ ${merchantId} associated ${id}` : `ℹ️  ${merchantId} already associated ${id}`);
  }

  // --- 5. Treasury transfers the NFT(s) to the merchant, in one transfer (treasury signs) ---
  let transferTx = new TransferTransaction();
  nftIds.forEach((id) => transferTx.addNftTransfer(id, treasuryId, merchantId));
  transferTx = transferTx.freezeWith(client);
  if (treasuryKey) transferTx = await transferTx.sign(treasuryKey);
  const transferResponse = await transferTx.execute(client);
  const transferReceipt = await transferResponse.getReceipt(client);
  transferTxId = transferResponse.transactionId.toString();
  console.log(`✅ ${nftIds.join(", ")} transferred to ${merchantId}: ${transferReceipt.status} (${transferTxId})`);

  // --- 6. Merchant grants UA an allowance on each NFT (merchant signs) ---
  const approve = new AccountAllowanceApproveTransaction();
  nftIds.forEach((id) => approve.approveTokenNftAllowance(id, merchantId, operatorId));
  const approveTx = await approve.freezeWith(client).sign(merchantKey);
  const approveResponse = await approveTx.execute(client);
  const approveReceipt = await approveResponse.getReceipt(client);
  const approveTxId = approveResponse.transactionId.toString();
  console.log(`✅ ${operatorId} may now sell ${nftIds.join(", ")}: ${approveReceipt.status} (${approveTxId})`);

  // --- 7. Record the transfer to the owner in HCS: one event for a piece and its stones ---
  const message = buildEvent(
    {
      event: "ISSUED_TO_OWNER",
      tokenId,
      serials: [serial],
      actorId: operatorId,
      ref: transferTxId,
      ...(plan.stoneId && { stoneId: plan.stoneId }),
    },
    { to_id: merchantId.toString(), allowance_ref: approveTxId, ...plan.fields },
  );
  const hcsTxId = await submitEvent(client, process.env.HCS_TOPIC_ID, message, loadSubmitKey(process.env));
  console.log(`✅ ISSUED_TO_OWNER recorded: ${hcsTxId}`);
}, {
  usage: USAGE,
  afterError: () => {
    if (transferTxId) {
      console.error(
        `   ${moving} already moved to the merchant in ${transferTxId}, but ISSUED_TO_OWNER was not recorded.`,
      );
    }
  },
});
