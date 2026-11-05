/**
 * @file consignToMerchant.js
 * @description Consigns a minted Umiña NFT serial to a merchant on Hedera
 * TESTNET: the merchant associates the Umiña token, the treasury transfers the
 * serial to the merchant, and the merchant grants UA (the operator account) an
 * NFT allowance so UA can sell it.
 *
 * Run from the command line:
 * node src/consignment/consignToMerchant.js <serial> [--dry-run]
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

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const serial = args.find((a) => !a.startsWith("--"));
dotenv.config({ path: ".env.testnet" });

const REQUIRED = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "TREASURY_ID",
  "UMINA_TOKEN_ID",
  "MERCHANT_ID",
  "MERCHANT_KEY",
];

async function main() {
  let client;
  try {
    // --- 1. Check the arguments and environment ---
    const problems = consignmentProblems(process.env, REQUIRED, serial);
    const treasuryProblem = treasuryKeyProblem(process.env);
    if (treasuryProblem) problems.push(treasuryProblem);
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
    const transferReceipt = await (await transferTx.execute(client)).getReceipt(client);
    console.log(`✅ ${nftId} transferred to ${merchantId}: ${transferReceipt.status}`);

    // --- 5. Merchant grants UA an allowance on this serial (merchant signs) ---
    const approveTx = await new AccountAllowanceApproveTransaction()
      .approveTokenNftAllowance(nftId, merchantId, operatorId)
      .freezeWith(client)
      .sign(merchantKey);
    const approveReceipt = await (await approveTx.execute(client)).getReceipt(client);
    console.log(`✅ ${operatorId} may now sell ${nftId}: ${approveReceipt.status}`);
  } catch (err) {
    console.error("❌ Consignment failed:", err);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

main();
