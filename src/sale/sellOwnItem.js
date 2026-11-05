/**
 * @file sellOwnItem.js
 * @description Sells an Umiña NFT that UA holds itself, straight from the
 * Treasury, on Hedera TESTNET, in one atomic transfer: the buyer pays the price
 * in HBAR to UA, and the Treasury sends the NFT to the buyer. The sale is then
 * recorded as SALE in HCS (umina-achala-chain#19).
 *
 * Run from the command line:
 * node src/sale/sellOwnItem.js <serial> <price-hbar> [--dry-run]
 *
 * UA (the operator) pays the fees and receives the price. The buyer signs
 * because HBAR leaves their account; on testnet BUYER_KEY simulates that. The
 * Treasury signs the NFT transfer: with TREASURY_KEY when it is not the
 * operator account. The buyer must have associated the Umiña token.
 *
 * No consignment, allowance or split is involved (see consignment/ for those).
 * A royalty is not expected, because the Treasury is the fee collector; check
 * the sale on HashScan to confirm (umina-achala-documents/consignment.md,
 * "To Verify on Testnet").
 */

import dotenv from "dotenv";
import {
  AccountId,
  Client,
  Hbar,
  NftId,
  TokenId,
  TokenNftInfoQuery,
  TransferTransaction,
} from "@hashgraph/sdk";
import { saleProblems } from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [serial, price] = args.filter((a) => !a.startsWith("--"));
dotenv.config({ path: ".env.testnet" });

async function main() {
  let client;
  try {
    // --- 1. Check the arguments and environment ---
    const problems = saleProblems(process.env, serial, price);
    if (problems.length) {
      console.error("❌ Problems found:");
      problems.forEach((p) => console.error(`   - ${p}`));
      process.exitCode = 1;
      return;
    }

    const uaId = AccountId.fromString(process.env.OPERATOR_ID);
    const treasuryId = AccountId.fromString(process.env.TREASURY_ID);
    const buyerId = AccountId.fromString(process.env.BUYER_ID);
    const tokenId = TokenId.fromString(process.env.UMINA_TOKEN_ID);
    const nftId = new NftId(tokenId, Number(serial));
    const buyerKey = parseEcdsaKey(process.env.BUYER_KEY);
    const treasuryKey =
      process.env.TREASURY_ID === process.env.OPERATOR_ID
        ? null
        : parseEcdsaKey(process.env.TREASURY_KEY);
    const priceHbar = Hbar.fromString(price);

    console.table({
      nft: nftId.toString(),
      from: treasuryId.toString(),
      to: buyerId.toString(),
      price: priceHbar.toString(),
    });

    if (dryRun) {
      console.log("Dry run, nothing sent.");
      return;
    }

    // --- 2. Connect to Hedera testnet as UA ---
    client = Client.forTestnet().setOperator(uaId, parseEcdsaKey(process.env.OPERATOR_KEY));

    // --- 3. Check the Treasury still holds the serial ---
    const [info] = await new TokenNftInfoQuery().setNftId(nftId).execute(client);
    if (info.accountId.toString() !== treasuryId.toString()) {
      console.error(
        `❌ ${nftId} is held by ${info.accountId}, not the Treasury ${treasuryId}. Remove the listing.`,
      );
      process.exitCode = 1;
      return;
    }

    // --- 4. One atomic transfer: the price to UA, the NFT to the buyer ---
    let saleTx = new TransferTransaction()
      .addHbarTransfer(buyerId, priceHbar.negated())
      .addHbarTransfer(uaId, priceHbar)
      .addNftTransfer(nftId, treasuryId, buyerId)
      .setTransactionMemo(`Umiña sale ${nftId}`)
      .freezeWith(client);
    saleTx = await saleTx.sign(buyerKey);
    if (treasuryKey) saleTx = await saleTx.sign(treasuryKey);
    const saleResponse = await saleTx.execute(client);
    const saleReceipt = await saleResponse.getReceipt(client);
    const saleTxId = saleResponse.transactionId.toString();
    console.log(`✅ Sold ${nftId} to ${buyerId}: ${saleReceipt.status} (${saleTxId})`);

    // --- 5. Record the sale in HCS ---
    // The sale has settled, so if this fails say so and keep what is needed
    // to record it by hand. submitEvent waits for the receipt, so a message
    // rejected at consensus lands here too.
    let hcsTxId;
    try {
      const message = buildEvent(
        { event: "SALE", tokenId, serials: [serial], actorId: uaId, ref: saleTxId },
        {
          seller_id: treasuryId.toString(),
          buyer_id: buyerId.toString(),
          payment: "on_chain",
          sold_for: priceHbar.toBigNumber().toString(),
          currency: "HBAR",
          price_tinybars: priceHbar.toTinybars().toString(),
        },
      );
      hcsTxId = await submitEvent(
        client,
        process.env.HCS_TOPIC_ID,
        message,
        loadSubmitKey(process.env),
      );
    } catch (err) {
      console.error(`❌ Sale ${saleTxId} settled but the HCS record failed:`, err);
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
