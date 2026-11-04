/**
 * @file sellConsigned.js
 * @description Sells a consigned Umiña NFT on Hedera TESTNET in one atomic
 * transfer: the buyer pays the price in HBAR, 70% goes to the merchant and 30%
 * to UA, and UA moves the NFT from the merchant to the buyer using the
 * merchant's allowance (see consignToMerchant.js). The sale is then notarized
 * in HCS.
 *
 * Run from the command line:
 * node src/sellConsigned.js <serial> <price-hbar> [--dry-run]
 *
 * UA (the operator) pays the fees and is the allowance spender, so the
 * merchant does not sign. The buyer signs because HBAR leaves their account;
 * on testnet BUYER_KEY simulates that. The buyer must have associated the
 * Umiña token. HTS takes the royalty from the merchant's share on top of this.
 */

import dotenv from "dotenv";
import {
  AccountId,
  Client,
  Hbar,
  NftId,
  TokenId,
  TokenNftInfoQuery,
  TopicMessageSubmitTransaction,
  TransactionId,
  TransferTransaction,
} from "@hashgraph/sdk";
import { consignmentProblems, consignmentSplit } from "./consignment.js";
import { parseEcdsaKey } from "./uminaToken.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [serial, price] = args.filter((a) => !a.startsWith("--"));
dotenv.config({ path: ".env.testnet" });

const REQUIRED = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "UMINA_TOKEN_ID",
  "HCS_TOPIC_ID",
  "MERCHANT_ID",
  "BUYER_ID",
  "BUYER_KEY",
];

const tinybars = (n) => Hbar.fromTinybars(n.toString());

async function main() {
  let client;
  try {
    // --- 1. Check the arguments and environment ---
    const problems = consignmentProblems(process.env, REQUIRED, serial);
    if (!(Number(price) > 0)) problems.push("give the price in HBAR as a positive number");
    if (problems.length) {
      console.error("❌ Problems found:");
      problems.forEach((p) => console.error(`   - ${p}`));
      process.exitCode = 1;
      return;
    }

    const uaId = AccountId.fromString(process.env.OPERATOR_ID);
    const merchantId = AccountId.fromString(process.env.MERCHANT_ID);
    const buyerId = AccountId.fromString(process.env.BUYER_ID);
    const tokenId = TokenId.fromString(process.env.UMINA_TOKEN_ID);
    const nftId = new NftId(tokenId, Number(serial));
    const buyerKey = parseEcdsaKey(process.env.BUYER_KEY);

    const priceTinybars = BigInt(new Hbar(Number(price)).toTinybars().toString());
    const split = consignmentSplit(priceTinybars);
    console.table({
      nft: nftId.toString(),
      price: tinybars(priceTinybars).toString(),
      merchant: tinybars(split.merchant).toString(),
      ua: tinybars(split.ua).toString(),
    });

    if (dryRun) {
      console.log("Dry run, nothing sent.");
      return;
    }

    // --- 2. Connect to Hedera testnet as UA ---
    client = Client.forTestnet().setOperator(
      uaId,
      parseEcdsaKey(process.env.OPERATOR_KEY),
    );

    // --- 3. Check the merchant still holds the serial ---
    // A sale on another marketplace would have moved it; fail early with a
    // clear message instead of a network error.
    const [info] = await new TokenNftInfoQuery().setNftId(nftId).execute(client);
    if (info.accountId.toString() !== merchantId.toString()) {
      console.error(
        `❌ ${nftId} is held by ${info.accountId}, not ${merchantId}. Remove the listing.`,
      );
      process.exitCode = 1;
      return;
    }

    // --- 4. One atomic transfer: payment split + NFT via allowance ---
    // UA is the payer, which makes it the allowance spender for the
    // approved NFT transfer. HBAR amounts must net to zero.
    const saleTx = await new TransferTransaction()
      .setTransactionId(TransactionId.generate(uaId))
      .addHbarTransfer(buyerId, tinybars(-priceTinybars))
      .addHbarTransfer(merchantId, tinybars(split.merchant))
      .addHbarTransfer(uaId, tinybars(split.ua))
      .addApprovedNftTransfer(nftId, merchantId, buyerId)
      .setTransactionMemo(`Umiña sale ${nftId}`)
      .freezeWith(client)
      .sign(buyerKey); // UA signs as operator on execute
    const saleResponse = await saleTx.execute(client);
    const saleReceipt = await saleResponse.getReceipt(client);
    const saleTxId = saleResponse.transactionId.toString();
    console.log(`✅ Sold ${nftId} to ${buyerId}: ${saleReceipt.status} (${saleTxId})`);

    // --- 5. Notarize the sale in HCS ---
    // The sale has settled, so if this fails say so and keep what is needed
    // to notarize it by hand.
    let hcsTxId;
    try {
      const hcsResponse = await new TopicMessageSubmitTransaction()
        .setTopicId(process.env.HCS_TOPIC_ID)
        .setMessage(
          JSON.stringify({
            event: "SALE",
            actor_id: uaId.toString(),
            token_id: tokenId.toString(),
            serial,
            merchant_id: merchantId.toString(),
            buyer_id: buyerId.toString(),
            price_tinybars: priceTinybars.toString(),
            merchant_tinybars: split.merchant.toString(),
            ua_tinybars: split.ua.toString(),
            sale_tx_id: saleTxId,
          }),
        )
        .execute(client);
      hcsTxId = hcsResponse.transactionId.toString();
    } catch (err) {
      console.error(`❌ Sale ${saleTxId} settled but the HCS notarization failed:`, err);
      process.exitCode = 1;
      return;
    }

    // --- 6. Provenance logging ---
    console.table({
      event: "SALE",
      nft: nftId.toString(),
      actor_id: uaId.toString(),
      sale_tx_id: saleTxId,
      hcs_tx_id: hcsTxId,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Sale failed:", err);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

main();
