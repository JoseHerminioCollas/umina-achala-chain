/**
 * @file sellOwnItem.js
 * @description Sells an NFT that UA holds itself, straight from the Treasury,
 * on Hedera (NETWORK, required), in one atomic transfer: the buyer
 * pays the price in HBAR to UA, and the Treasury sends the NFT to the buyer.
 * The sale is then recorded as SALE in HCS (umina-achala-chain#19).
 *
 * Run from the command line, with NETWORK set (testnet or mainnet; it has no
 * default and the script refuses to run without it, see src/network.js):
 * NETWORK=testnet node src/sale/sellOwnItem.js <serial> <price-hbar> [--token umina|achala] [--dry-run]
 *
 * An Umiña (a stone, the default) is refused while it is mounted in an
 * Achala that still exists: it moves only with its Achala (#24).
 *
 * With --token achala the serial is an Achala (a piece of jewelry), and the
 * same transfer also moves every Umiña mounted in it, so a piece with N
 * stones moves N+1 NFTs (#16, #26). Its stones come from the Achala's MINT
 * event (from_stone_ids) and each stone's serial from its own MINT. One
 * transfer moves at most 10 NFTs (MAX_NFT_TRANSFERS in mint/achala.js). The
 * SALE names the Achala and adds its stones and their Umiña serials. The
 * buyer must have associated both tokens (associateToken.js --token).
 *
 * UA (the operator) pays the fees and receives the price. The buyer signs
 * because HBAR leaves their account; on testnet BUYER_KEY simulates that. The
 * Treasury signs the NFT transfer: with TREASURY_KEY when it is not the
 * operator account.
 *
 * Every run reads the provenance topic first; --dry-run does that check,
 * shows the sale and sends nothing.
 *
 * No consignment, allowance or split is involved (see consignment/ for those).
 * A royalty is not expected, because the Treasury is the fee collector; check
 * the sale on HashScan to confirm (umina-achala-documents/consignment.md,
 * "To Verify on Testnet").
 */

import {
  AccountId,
  Hbar,
  NftId,
  TokenId,
  TransferTransaction,
} from "@hashgraph/sdk";
import { parseSaleArgs, saleProblems } from "./lib.js";
import { holderProblems, readHolders } from "../nfts.js";
import { parseEcdsaKey } from "../keys.js";
import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";
import { mountIds, readProvenance } from "../provenance.js";
import { achalaSaleFields, achalaSalePlan, mountedProblem } from "../mint/achala.js";
import { TOKEN_CLASSES } from "../token/lib.js";
import { fail, loadEnv, runScript } from "../script.js";

const input = parseSaleArgs(process.argv.slice(2));
const { serial, price, tokenClass, dryRun } = input;
const isAchala = tokenClass === "achala";
loadEnv();


const USAGE = `Sell an item UA holds itself, from the Treasury, in one transfer: the buyer
pays UA and the NFT goes to the buyer (an Achala with its stones). Recorded
as SALE.

Usage: NETWORK=testnet node src/sale/sellOwnItem.js <serial> <price-hbar> [--token umina|achala] [--dry-run]

  <serial>               the NFT serial, held by the Treasury
  <price-hbar>           the price in HBAR
  --token umina|achala   the token class (default umina)`;

runScript("Sale failed", async (session) => {
  // --- 1. Check the arguments and environment ---
  const problems = [...input.problems];
  if (!problems.length) problems.push(...saleProblems(process.env, serial, price, tokenClass));
  if (problems.length) return fail(problems);

  const { name: className, envVar } = TOKEN_CLASSES[tokenClass];
  const uaId = AccountId.fromString(process.env.OPERATOR_ID);
  const treasuryId = AccountId.fromString(process.env.TREASURY_ID);
  const buyerId = AccountId.fromString(process.env.BUYER_ID);
  const tokenId = TokenId.fromString(process.env[envVar]);
  const nftId = new NftId(tokenId, Number(serial));
  const buyerKey = parseEcdsaKey(process.env.BUYER_KEY);
  const treasuryKey =
    process.env.TREASURY_ID === process.env.OPERATOR_ID
      ? null
      : parseEcdsaKey(process.env.TREASURY_KEY);
  const priceHbar = Hbar.fromString(price);

  // --- 2. Check the item against the provenance topic ---
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
  const ids = mountIds(process.env, serial);
  // An Achala moves with its stones; an Umiña must not be in an Achala
  let plan = { stones: [] };
  if (isAchala) {
    plan = achalaSalePlan(events, ids);
    if (plan.problems.length) return fail(plan.problems);
  } else {
    const mounted = mountedProblem(events, ids);
    if (mounted) return fail([mounted]);
  }
  const uminaTokenId = isAchala ? TokenId.fromString(process.env.UMINA_TOKEN_ID) : null;
  const nftIds = [nftId, ...plan.stones.map((s) => new NftId(uminaTokenId, Number(s.serial)))];

  console.table({
    nft: nftId.toString(),
    ...(isAchala && { piece: plan.achalaId, stones: plan.stones.map((s) => s.stone_id).join(", ") }),
    from: treasuryId.toString(),
    to: buyerId.toString(),
    price: priceHbar.toString(),
  });

  if (dryRun) {
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 3. Check the Treasury still holds every NFT that moves (mirror node, nfts.js) ---
  const held = holderProblems(nftIds, await readHolders(nftIds), treasuryId.toString());
  if (held.length) return fail(held);

  // --- 4. Connect to Hedera as UA ---
  const client = session.connect();

  // --- 5. One atomic transfer: the price to UA, the NFT(s) to the buyer ---
  let saleTx = new TransferTransaction()
    .addHbarTransfer(buyerId, priceHbar.negated())
    .addHbarTransfer(uaId, priceHbar);
  for (const id of nftIds) saleTx = saleTx.addNftTransfer(id, treasuryId, buyerId);
  saleTx = saleTx.setTransactionMemo(`${className} sale ${nftId}`).freezeWith(client);
  saleTx = await saleTx.sign(buyerKey);
  if (treasuryKey) saleTx = await saleTx.sign(treasuryKey);
  const saleResponse = await saleTx.execute(client);
  const saleReceipt = await saleResponse.getReceipt(client);
  const saleTxId = saleResponse.transactionId.toString();
  console.log(`✅ Sold ${nftIds.join(", ")} to ${buyerId}: ${saleReceipt.status} (${saleTxId})`);

  // --- 6. Record the sale in HCS ---
  // The sale has settled, so if this fails say so and keep what is needed
  // to record it by hand. submitEvent waits for the receipt, so a message
  // rejected at consensus lands here too.
  let hcsTxId;
  try {
    const message = buildEvent(
      {
        event: "SALE",
        ...(isAchala && { stoneId: plan.achalaId }),
        tokenId,
        serials: [serial],
        actorId: uaId,
        ref: saleTxId,
      },
      {
        seller_id: treasuryId.toString(),
        buyer_id: buyerId.toString(),
        payment: "on_chain",
        sold_for: priceHbar.toBigNumber().toString(),
        currency: "HBAR",
        price_tinybars: priceHbar.toTinybars().toString(),
        ...(isAchala && achalaSaleFields(plan.stones, uminaTokenId)),
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

  // --- 7. Provenance logging ---
  console.table({
    event: "SALE",
    nft: nftId.toString(),
    actor_id: uaId.toString(),
    sale_tx_id: saleTxId,
    hcs_tx_id: hcsTxId,
    timestamp: new Date().toISOString(),
  });
}, { usage: USAGE });
