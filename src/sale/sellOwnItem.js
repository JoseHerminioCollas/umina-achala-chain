/**
 * @file sellOwnItem.js
 * @description Sells an NFT that UA holds itself, straight from the Treasury,
 * on Hedera (NETWORK, required), in one atomic transfer: the buyer
 * pays the price in HBAR to UA, and the Treasury sends the NFT to the buyer.
 * The sale is then recorded as SALE in HCS (umina-achala-chain#19), and
 * UNLISTED (reason "sold") is posted to the display topic, as after a sale on
 * the site (umina-achala-web#116), so the item leaves the site's catalog.
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
 * Every run reads the provenance topic and the holders (mirror node) first,
 * then checks the listing and the buyer (sale/lib.js saleChecks): it warns
 * when the item is not listed on the site, or is listed at another price,
 * and refuses a buyer who has not associated the token(s) or holds less HBAR
 * than the price. An item that was not listed gets SALE but no UNLISTED.
 * --dry-run does all of these checks, shows the sale and sends nothing.
 *
 * No consignment, allowance or split is involved (see consignment/ for those).
 * A royalty is not expected, because the Treasury is the fee collector; check
 * the sale on HashScan to confirm (umina-achala-documents/consignment.md,
 * "To Verify on Testnet").
 */

import { AccountId, Hbar } from "@hashgraph/sdk";
import { parseSaleArgs, planSale, recordSold, saleChecks, saleProblems, saleTransaction } from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { loadSubmitKey } from "../hcs.js";
import { readProvenance } from "../provenance.js";
import { fail, loadEnv, runScript } from "../script.js";

const input = parseSaleArgs(process.argv.slice(2));
const { serial, price, tokenClass, dryRun } = input;
const isAchala = tokenClass === "achala";
loadEnv();


const USAGE = `Sell an item UA holds itself, from the Treasury, in one transfer: the buyer
pays UA and the NFT goes to the buyer (an Achala with its stones). Recorded
as SALE, and UNLISTED (sold) on the display topic.

Usage: NETWORK=testnet node src/sale/sellOwnItem.js <serial> <price-hbar> [--token umina|achala] [--dry-run]

  <serial>               the NFT serial, held by the Treasury
  <price-hbar>           the price in HBAR
  --token umina|achala   the token class (default umina)
  --dry-run              check everything and show the sale, send nothing`;

runScript("Sale failed", async (session) => {
  // --- 1. Check the arguments and environment ---
  const problems = [...input.problems];
  if (!problems.length) problems.push(...saleProblems(process.env, serial, price, tokenClass));
  if (problems.length) return fail(problems);

  const uaId = AccountId.fromString(process.env.OPERATOR_ID);
  const treasuryId = AccountId.fromString(process.env.TREASURY_ID);
  const buyerId = AccountId.fromString(process.env.BUYER_ID);
  const buyerKey = parseEcdsaKey(process.env.BUYER_KEY);
  const treasuryKey =
    process.env.TREASURY_ID === process.env.OPERATOR_ID
      ? null
      : parseEcdsaKey(process.env.TREASURY_KEY);
  const priceHbar = Hbar.fromString(price);

  // --- 2. Check the item against the provenance topic, and the Treasury
  // still holds every NFT that moves (sale/lib.js planSale) ---
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
  const plan = await planSale(process.env, events, { tokenClass, serial });
  if (plan.problems.length) return fail(plan.problems);
  const { nftId, nftIds } = plan;

  // --- 3. Check the listing on the site (warnings) and that the buyer can
  // receive the NFT(s) and pay (problems) ---
  const checks = await saleChecks(process.env, plan, { buyerId, price: priceHbar });
  checks.warnings.forEach((w) => console.warn(`⚠️  ${w}`));
  if (checks.problems.length) return fail(checks.problems);

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

  // --- 4. Connect to Hedera as UA ---
  const client = session.connect();

  // --- 5. One atomic transfer: the price to UA, the NFT(s) to the buyer ---
  const parties = { uaId, treasuryId, buyerId, price: priceHbar };
  let saleTx = saleTransaction(parties, plan).freezeWith(client);
  saleTx = await saleTx.sign(buyerKey);
  if (treasuryKey) saleTx = await saleTx.sign(treasuryKey);
  const saleResponse = await saleTx.execute(client);
  const saleReceipt = await saleResponse.getReceipt(client);
  const saleTxId = saleResponse.transactionId.toString();
  console.log(`✅ Sold ${nftIds.join(", ")} to ${buyerId}: ${saleReceipt.status} (${saleTxId})`);

  // --- 6. Record the sale: SALE on the provenance topic, UNLISTED (reason
  // "sold") on the display topic, as a sale on the site does (sale/lib.js
  // recordSold). The sale has settled, so a step that fails is printed with
  // how to record it by hand.
  const recorded = await recordSold(client, process.env, { ...parties, saleTxId }, plan, {
    submitKey: loadSubmitKey(process.env),
    unlist: checks.listed !== false,
  });
  if (recorded.problems.length) {
    console.error(`❌ Sale ${saleTxId} settled, but:`);
    recorded.problems.forEach((p) => console.error(`   - ${p}`));
    process.exitCode = 1;
  }
  const hcsTxId = recorded.saleEventTxId;

  // --- 7. Provenance logging ---
  console.table({
    event: "SALE",
    nft: nftId.toString(),
    actor_id: uaId.toString(),
    sale_tx_id: saleTxId,
    hcs_tx_id: hcsTxId ?? "-",
    unlisted_tx_id: recorded.unlistedTxId ?? "-",
    timestamp: new Date().toISOString(),
  });
}, { usage: USAGE });
