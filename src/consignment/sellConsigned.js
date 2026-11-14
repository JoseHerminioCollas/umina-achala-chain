/**
 * @file sellConsigned.js
 * @description Sells a consigned Umiña NFT, or with --token achala a
 * consigned Achala with every Umiña stone in it, on Hedera (NETWORK,
 * required) in one atomic transfer: the buyer pays the price in HBAR to the
 * merchant and UA, and UA moves the NFT(s) from the merchant to the buyer
 * using the merchant's allowance (see consignToMerchant.js). The sale is then
 * notarized in HCS as one SALE (umina-achala-chain#18, #28).
 *
 * The merchant ends with 70% and UA with 30%, the royalty included
 * (umina-achala-chain#30): HTS takes the 5% royalty from the merchant's leg
 * and pays it to the Treasury, so the merchant's leg is 70% / 0.95 (73.68 on
 * 100) and UA's the rest (26.32). See consignmentSplit in lib.js. How the
 * royalty applies when an Achala moves with its stones (N+1 NFTs, one
 * payment) is checked on testnet (#22).
 *
 * Run from the command line, with NETWORK set (testnet or mainnet; it has no
 * default and the script refuses to run without it, see src/network.js):
 * NETWORK=testnet node src/consignment/sellConsigned.js <serial> <price-hbar> [--token umina|achala] [--dry-run]
 *
 * An Umiña mounted in an Achala that still exists is refused: it is sold
 * only with its Achala (#24). The provenance topic and the holders (mirror
 * node) are read first, also on --dry-run.
 *
 * UA (the operator) pays the fees and is the allowance spender, so the
 * merchant does not sign. The buyer signs because HBAR leaves their account;
 * on testnet BUYER_KEY simulates that. The buyer must have associated the
 * token(s): associateToken.js buyer [--token achala].
 */

import { AccountId, Hbar, TokenId, TransactionId, TransferTransaction } from "@hashgraph/sdk";
import { consignmentNfts, consignmentProblems, consignmentSplit, tokenVars } from "./lib.js";
import { buildEvent, loadSubmitKey, submitEvent, submitKeyProblem } from "../hcs.js";
import { parseEcdsaKey } from "../keys.js";
import { readProvenance } from "../provenance.js";
import { holderProblems, readHolders } from "../nfts.js";
import { fail, loadEnv, parseScriptArgs, runScript } from "../script.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";

const args = parseScriptArgs({ "dry-run": { type: "boolean" }, token: { type: "string" } }, 2);
const dryRun = Boolean(args.values["dry-run"]);
const tokenClass = args.values.token ?? "umina";
const [serial, price] = args.positionals;
loadEnv();

const REQUIRED = ["OPERATOR_ID", "OPERATOR_KEY", "HCS_TOPIC_ID", "MERCHANT_ID", "BUYER_ID", "BUYER_KEY"];

const tinybars = (n) => Hbar.fromTinybars(n.toString());

const USAGE = `Sell a consigned Umiña, or a consigned Achala with its stones, in one
transfer: the buyer pays, the merchant ends with 70% and UA with 30% after
the royalty, and the NFT(s) go to the buyer. Recorded as SALE. A stone
mounted in an Achala is refused on its own.

Usage: NETWORK=testnet node src/consignment/sellConsigned.js <serial> <price-hbar> [--token umina|achala] [--dry-run]

  <serial>               the NFT serial in the class's token, held by the merchant
  <price-hbar>           the price in HBAR
  --token umina|achala   the token class (default umina); an Achala moves with its stones`;

// Exported so tests can wait for the run to finish
export const done = runScript("Sale failed", async (session) => {
  // --- 1. Check the arguments and environment ---
  if (args.problems.length) return fail(args.problems);
  const classProblem = tokenClassProblem(tokenClass);
  if (classProblem) return fail([classProblem]);
  const problems = consignmentProblems(process.env, [...REQUIRED, ...tokenVars(tokenClass)], serial);
  if (!(Number(price) > 0)) problems.push("give the price in HBAR as a positive number");
  const submitProblem = submitKeyProblem(process.env);
  if (submitProblem) problems.push(submitProblem);
  if (problems.length) return fail(problems);

  const { name: className, envVar } = TOKEN_CLASSES[tokenClass];
  const uaId = AccountId.fromString(process.env.OPERATOR_ID);
  const merchantId = AccountId.fromString(process.env.MERCHANT_ID);
  const buyerId = AccountId.fromString(process.env.BUYER_ID);
  const tokenId = TokenId.fromString(process.env[envVar]);
  const buyerKey = parseEcdsaKey(process.env.BUYER_KEY);

  // --- 2. What moves, from the provenance topic (#24, #28), and the merchant still holds it ---
  // A sale on another marketplace would have moved it; fail early with a
  // clear message instead of a network error.
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
  const plan = consignmentNfts(events, process.env, serial, tokenClass);
  if (plan.problems.length) return fail(plan.problems);
  const { nftIds } = plan;
  const [nftId] = nftIds;
  const held = holderProblems(nftIds, await readHolders(nftIds), merchantId.toString(), {
    holder: "the merchant",
  });
  if (held.length) return fail(held);

  const priceTinybars = BigInt(new Hbar(Number(price)).toTinybars().toString());
  const split = consignmentSplit(priceTinybars);
  console.log(`Sale of ${nftIds.join(", ")} for ${tinybars(priceTinybars)}:`);
  console.table({
    merchant: {
      paid: tinybars(split.merchant).toString(),
      after_royalty: tinybars(split.merchantNet).toString(),
    },
    ua: { paid: tinybars(split.ua).toString(), after_royalty: tinybars(split.uaNet).toString() },
  });

  if (dryRun) {
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 3. Connect to Hedera as UA ---
  const client = session.connect();

  // --- 4. One atomic transfer: payment split + the NFT(s) via allowance ---
  // UA is the payer, which makes it the allowance spender for the
  // approved NFT transfers. HBAR amounts must net to zero.
  const sale = new TransferTransaction()
    .setTransactionId(TransactionId.generate(uaId))
    .addHbarTransfer(buyerId, tinybars(-priceTinybars))
    .addHbarTransfer(merchantId, tinybars(split.merchant))
    .addHbarTransfer(uaId, tinybars(split.ua));
  nftIds.forEach((id) => sale.addApprovedNftTransfer(id, merchantId, buyerId));
  const saleTx = await sale
    .setTransactionMemo(`${className} sale ${nftId}`)
    .freezeWith(client)
    .sign(buyerKey); // UA signs as operator on execute
  const saleResponse = await saleTx.execute(client);
  const saleReceipt = await saleResponse.getReceipt(client);
  const saleTxId = saleResponse.transactionId.toString();
  console.log(`✅ Sold ${nftIds.join(", ")} to ${buyerId}: ${saleReceipt.status} (${saleTxId})`);

  // --- 5. Notarize the sale in HCS ---
  // The sale has settled, so if this fails say so and keep what is needed
  // to notarize it by hand. submitEvent waits for the receipt, so a message
  // rejected at consensus lands here too. SALE fields follow the event
  // catalog in umina-achala-chain#10; the split is kept in tinybars, as the
  // legs paid (the merchant's before HTS takes the royalty from it, #30). An
  // Achala's SALE names its stones and their Umiña serials, as in #26.
  let hcsTxId;
  try {
    const message = buildEvent(
      {
        event: "SALE",
        tokenId,
        serials: [serial],
        actorId: uaId,
        ref: saleTxId,
        ...(plan.stoneId && { stoneId: plan.stoneId }),
      },
      {
        seller_id: merchantId.toString(),
        buyer_id: buyerId.toString(),
        payment: "on_chain",
        sold_for: tinybars(priceTinybars).toBigNumber().toString(),
        currency: "HBAR",
        price_tinybars: priceTinybars.toString(),
        merchant_tinybars: split.merchant.toString(),
        ua_tinybars: split.ua.toString(),
        ...plan.fields,
      },
    );
    hcsTxId = await submitEvent(client, process.env.HCS_TOPIC_ID, message, loadSubmitKey(process.env));
  } catch (err) {
    console.error(`❌ Sale ${saleTxId} settled but the HCS notarization failed:`, err);
    process.exitCode = 1;
    return;
  }

  // --- 6. Provenance logging ---
  console.table({
    event: "SALE",
    nft: nftIds.join(", "),
    actor_id: uaId.toString(),
    sale_tx_id: saleTxId,
    hcs_tx_id: hcsTxId,
    timestamp: new Date().toISOString(),
  });
}, { usage: USAGE });
