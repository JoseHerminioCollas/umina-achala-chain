/**
 * @file consignToMerchant.js
 * @description Consigns a minted Umiña NFT serial to a merchant on Hedera
 * TESTNET: the merchant associates the Umiña token, the treasury transfers the
 * serial to the merchant, the merchant grants UA (the operator account) an
 * NFT allowance so UA can sell it, and the transfer is recorded in HCS as
 * ISSUED_TO_OWNER (umina-achala-chain#10, #18).
 *
 * Run from the command line:
 * node src/consignment/consignToMerchant.js <serial> [--dry-run]
 *
 * The event is recorded only after the transfer and the allowance have both
 * succeeded. If a step fails after the NFT has moved, the script says what
 * already happened on the ledger, so it can be finished or recorded by hand.
 *
 * Testnet only: the merchant's key is read from .env.testnet to simulate the
 * merchant signing. In production the merchant signs in their own wallet.
 */

import dotenv from "dotenv";
import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Client,
  NftId,
  TokenId,
  TransferTransaction,
} from "@hashgraph/sdk";
import { associateToken, consignmentProblems } from "./lib.js";
import { parseEcdsaKey, treasuryKeyProblem } from "../keys.js";
import { buildEvent, loadSubmitKey, submitEvent, submitKeyProblem } from "../hcs.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const serial = args.find((a) => !a.startsWith("--"));
dotenv.config({ path: ".env.testnet" });

const REQUIRED = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "TREASURY_ID",
  "UMINA_TOKEN_ID",
  "HCS_TOPIC_ID",
  "MERCHANT_ID",
  "MERCHANT_KEY",
];

async function main() {
  let client;
  let transferTxId;
  try {
    // --- 1. Check the arguments and environment ---
    const problems = consignmentProblems(process.env, REQUIRED, serial);
    for (const problem of [treasuryKeyProblem(process.env), submitKeyProblem(process.env)]) {
      if (problem) problems.push(problem);
    }
    if (problems.length) {
      console.error("❌ Problems found:");
      problems.forEach((p) => console.error(`   - ${p}`));
      process.exitCode = 1;
      return;
    }

    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    const treasuryId = AccountId.fromString(process.env.TREASURY_ID);
    const merchantId = AccountId.fromString(process.env.MERCHANT_ID);
    const tokenId = TokenId.fromString(process.env.UMINA_TOKEN_ID);
    const nftId = new NftId(tokenId, Number(serial));
    const merchantKey = parseEcdsaKey(process.env.MERCHANT_KEY);
    const treasuryKey = process.env.TREASURY_KEY
      ? parseEcdsaKey(process.env.TREASURY_KEY)
      : null;

    if (dryRun) {
      console.log(`Would associate ${tokenId} with ${merchantId}`);
      console.log(`Would transfer ${nftId} from ${treasuryId} to ${merchantId}`);
      console.log(`Would approve ${operatorId} to sell ${nftId} for ${merchantId}`);
      console.log(`Would record ISSUED_TO_OWNER to ${merchantId} in ${process.env.HCS_TOPIC_ID}`);
      console.log("Dry run, nothing sent.");
      return;
    }

    // --- 2. Connect to Hedera testnet (UA pays the fees) ---
    client = Client.forTestnet().setOperator(
      operatorId,
      parseEcdsaKey(process.env.OPERATOR_KEY),
    );

    // --- 3. Merchant associates the Umiña token (merchant signs) ---
    const associated = await associateToken(client, merchantId, merchantKey, tokenId);
    console.log(
      associated
        ? `✅ ${merchantId} associated ${tokenId}`
        : `ℹ️  ${merchantId} already associated ${tokenId}`,
    );

    // --- 4. Treasury transfers the serial to the merchant (treasury signs) ---
    let transferTx = new TransferTransaction()
      .addNftTransfer(nftId, treasuryId, merchantId)
      .freezeWith(client);
    if (treasuryKey) transferTx = await transferTx.sign(treasuryKey);
    const transferResponse = await transferTx.execute(client);
    const transferReceipt = await transferResponse.getReceipt(client);
    transferTxId = transferResponse.transactionId.toString();
    console.log(`✅ ${nftId} transferred to ${merchantId}: ${transferReceipt.status} (${transferTxId})`);

    // --- 5. Merchant grants UA an allowance on this serial (merchant signs) ---
    const approveTx = await new AccountAllowanceApproveTransaction()
      .approveTokenNftAllowance(nftId, merchantId, operatorId)
      .freezeWith(client)
      .sign(merchantKey);
    const approveResponse = await approveTx.execute(client);
    const approveReceipt = await approveResponse.getReceipt(client);
    const approveTxId = approveResponse.transactionId.toString();
    console.log(`✅ ${operatorId} may now sell ${nftId}: ${approveReceipt.status} (${approveTxId})`);

    // --- 6. Record the transfer to the owner in HCS ---
    const message = buildEvent(
      { event: "ISSUED_TO_OWNER", tokenId, serials: [serial], actorId: operatorId, ref: transferTxId },
      { to_id: merchantId.toString(), allowance_ref: approveTxId },
    );
    const hcsTxId = await submitEvent(
      client,
      process.env.HCS_TOPIC_ID,
      message,
      loadSubmitKey(process.env),
    );
    console.log(`✅ ISSUED_TO_OWNER recorded: ${hcsTxId}`);
  } catch (err) {
    console.error("❌ Consignment failed:", err);
    if (transferTxId) {
      console.error(
        `   The NFT already moved to the merchant in ${transferTxId}, but ISSUED_TO_OWNER was not recorded.`,
      );
    }
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

main();
