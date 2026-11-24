/**
 * @file sale/lib.js
 * @description A sale of an item UA holds itself, from the Treasury, in parts
 * that both sellOwnItem.js (the command line) and the sale backend
 * (umina-achala-server, umina-achala-web#116) use, so a sale ends the same
 * way from either: the argument and environment checks, the plan (what moves,
 * checked against the provenance topic and the holders), the one atomic
 * transfer, and what follows a settled sale: SALE on the provenance topic and
 * UNLISTED (reason "sold") on the display topic (recordSold).
 */

import { parseArgs } from "util";
import { AccountId, Hbar, NftId, TokenId, TransferTransaction } from "@hashgraph/sdk";
import { holderProblems, readHolders } from "../nfts.js";
import { mountIds, readDisplay } from "../provenance.js";
import { buyerAccount, latestArrival } from "../mirror.js";
import { achalaSaleFields, achalaSalePlan, mintOfSerial, mountedProblem } from "../mint/achala.js";
import { buildEvent, submitEvent, submitKeyProblem } from "../hcs.js";
import { canonicalHbar, currentListing, displayFields } from "../display/lib.js";
import { treasuryKeyProblem } from "../keys.js";
import { envProblems, serialProblem } from "../env.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";

/**
 * Variables sellOwnItem.js needs, besides the token class's own ID
 * (UMINA_TOKEN_ID or ACHALA_TOKEN_ID). TREASURY_KEY is checked separately.
 */
export const REQUIRED = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "TREASURY_ID",
  "HCS_TOPIC_ID",
  "HCS_DISPLAY_TOPIC_ID",
  "BUYER_ID",
  "BUYER_KEY",
];

/**
 * Parses the command line of sellOwnItem.js:
 * <serial> <price-hbar> [--token umina|achala] [--dry-run].
 * Returns { serial, price, tokenClass, dryRun, problems }.
 */
export function parseSaleArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, token: { type: "string" } },
      allowPositionals: true,
    }));
  } catch (err) {
    return { problems: [err.message] };
  }
  const [serial, price] = positionals;
  const input = { serial, price, tokenClass: values.token ?? "umina", dryRun: Boolean(values["dry-run"]) };
  const problems = [];
  if (positionals.length > 2) problems.push(`give a serial and a price, got ${positionals.join(" ")}`);
  const tokenProblem = tokenClassProblem(input.tokenClass);
  if (tokenProblem) problems.push(tokenProblem);
  return { ...input, problems };
}

/**
 * Lists the problems with the serial, the price and the environment. An
 * Achala sale also needs UMINA_TOKEN_ID, to move its stones.
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} serial
 * @param {string | undefined} price in HBAR
 * @param {"umina" | "achala"} [tokenClass]
 * @returns {string[]}
 */
export function saleProblems(env, serial, price, tokenClass = "umina") {
  const needed = [...REQUIRED];
  needed.splice(3, 0, TOKEN_CLASSES[tokenClass].envVar);
  if (tokenClass === "achala") needed.splice(3, 0, "UMINA_TOKEN_ID");
  const problems = envProblems(env, needed);
  const bad = serialProblem(serial);
  if (bad) problems.push(bad);
  if (!/^\d+(\.\d{1,8})?$/.test(price ?? "") || !(Number(price) > 0)) {
    problems.push("give the price in HBAR as a positive number, at most 8 decimals");
  }
  for (const problem of [treasuryKeyProblem(env), submitKeyProblem(env)]) {
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * What a sale of one item moves, checked: an Achala moves with its mounted
 * stones, an Umiña mounted in an Achala that still exists is refused, and the
 * Treasury must hold every NFT that moves (mirror node).
 * @param {Record<string, string | undefined>} env the token IDs and TREASURY_ID
 * @param {object[]} events the provenance topic's events
 * @param {{ tokenClass: "umina" | "achala", serial: string }} item
 * @param {{ holders?: typeof readHolders }} [deps]
 * @returns {Promise<{ problems: string[] } | { problems: [], tokenClass: string, tokenId: TokenId,
 *   nftId: NftId, nftIds: NftId[], stoneId?: string, achalaId?: string, stones: object[], uminaTokenId: TokenId | null }>}
 */
export async function planSale(env, events, { tokenClass, serial }, { holders = readHolders } = {}) {
  const isAchala = tokenClass === "achala";
  const tokenId = TokenId.fromString(env[TOKEN_CLASSES[tokenClass].envVar]);
  const nftId = new NftId(tokenId, Number(serial));
  const ids = mountIds(env, serial);
  let plan = { stones: [] };
  if (isAchala) {
    plan = achalaSalePlan(events, ids);
    if (plan.problems.length) return { problems: plan.problems };
  } else {
    const mounted = mountedProblem(events, ids);
    if (mounted) return { problems: [mounted] };
  }
  const uminaTokenId = isAchala ? TokenId.fromString(env.UMINA_TOKEN_ID) : null;
  const nftIds = [nftId, ...plan.stones.map((s) => new NftId(uminaTokenId, Number(s.serial)))];
  const held = holderProblems(nftIds, await holders(nftIds), env.TREASURY_ID);
  if (held.length) return { problems: held };
  return {
    problems: [],
    tokenClass,
    tokenId,
    nftId,
    nftIds,
    // the item's own stone_id, from its MINT (an Achala's is its achalaId)
    stoneId: mintOfSerial(events, tokenId.toString(), serial)?.event.stone_id,
    ...(isAchala && { achalaId: plan.achalaId }),
    stones: plan.stones,
    uminaTokenId,
  };
}

/**
 * The checks a sale from the command line makes before anything is sent,
 * also on --dry-run, besides planSale. The sale backend makes its own,
 * stricter ones (it sells only listed items, at the listed price).
 *
 * Warnings (the sale may go ahead): the item is not listed on the site, or is
 * listed at another price, or the display topic could not be read. Problems
 * (nothing is sent): the buyer's account does not exist, has not associated
 * a token that moves, or holds less HBAR than the price (UA pays the fee).
 *
 * `listed` is false only when the display topic was read and the item is not
 * listed, so that UNLISTED is not posted for it after the sale.
 * @param {Record<string, string | undefined>} env TREASURY_ID, HCS_DISPLAY_TOPIC_ID
 * @param {object} plan from planSale
 * @param {{ buyerId: string, price: Hbar }} sale
 * @param {{ display?: typeof readDisplay, arrival?: typeof latestArrival, account?: typeof buyerAccount }} [deps]
 * @returns {Promise<{ problems: string[], warnings: string[], listed: boolean | null }>}
 */
export async function saleChecks(env, plan, { buyerId, price }, deps = {}) {
  const { display = readDisplay, arrival = latestArrival, account = buyerAccount } = deps;
  const out = { problems: [], warnings: [], listed: null };
  const tokenId = plan.tokenId.toString();
  const serial = String(plan.nftId.serial);
  const item = plan.stoneId ? `${plan.stoneId} (${plan.nftId})` : String(plan.nftId);
  const asked = canonicalHbar(price.toBigNumber().toFixed());

  // The listing on the site: listed since the NFT last came to the Treasury
  try {
    const shown = await display(env);
    if (shown.problem) throw new Error(shown.problem);
    const since = await arrival(tokenId, serial, env.TREASURY_ID);
    const listing = currentListing(shown.events, tokenId, serial, since);
    out.listed = listing.listed;
    if (!listing.listed) {
      out.warnings.push(`${item} is not listed on the site; UNLISTED will not be posted after the sale`);
    } else if (listing.price !== asked) {
      out.warnings.push(`${item} is listed on the site at ${listing.price} HBAR; this sale is for ${asked} HBAR`);
    }
  } catch (err) {
    out.warnings.push(`the listing was not checked (${err.message})`);
  }

  // The buyer can receive every token that moves, and pay the price
  const tokenIds = [...new Set(plan.nftIds.map((id) => id.tokenId.toString()))];
  try {
    const buyer = await account(String(buyerId), tokenIds);
    if (!buyer) {
      out.problems.push(`the buyer's account ${buyerId} was not found on the mirror node`);
      return out;
    }
    if (buyer.notAssociated.length) {
      const token = plan.tokenClass === "achala" ? " --token achala" : "";
      out.problems.push(
        `the buyer ${buyerId} has not associated ${buyer.notAssociated.join(" and ")}: run associateToken.js buyer${token} first`,
      );
    }
    if (buyer.balance !== null && BigInt(buyer.balance) < BigInt(price.toTinybars().toString())) {
      out.problems.push(
        `the buyer ${buyerId} holds ${canonicalHbar(Hbar.fromTinybars(buyer.balance).toBigNumber().toFixed())} HBAR, less than the price of ${asked} HBAR`,
      );
    }
  } catch (err) {
    out.problems.push(`cannot check the buyer's account ${buyerId} (${err.message})`);
  }
  return out;
}

/**
 * The one atomic transfer of a sale, not yet frozen: the buyer pays the price
 * to UA, and the Treasury sends every NFT of the plan to the buyer.
 * @param {{ uaId: string, treasuryId: string, buyerId: string, price: import("@hashgraph/sdk").Hbar }} parties
 * @param {{ tokenClass: string, nftId: NftId, nftIds: NftId[] }} plan from planSale
 * @returns {TransferTransaction}
 */
export function saleTransaction({ uaId, treasuryId, buyerId, price }, plan) {
  const buyer = AccountId.fromString(String(buyerId));
  const treasury = AccountId.fromString(String(treasuryId));
  let tx = new TransferTransaction()
    .addHbarTransfer(buyer, price.negated())
    .addHbarTransfer(AccountId.fromString(String(uaId)), price);
  for (const id of plan.nftIds) tx = tx.addNftTransfer(id, treasury, buyer);
  return tx.setTransactionMemo(`${TOKEN_CLASSES[plan.tokenClass].name} sale ${plan.nftId}`);
}

/**
 * The SALE event of a settled sale (umina-achala-chain#17, #19).
 * @param {{ uaId: string, treasuryId: string, buyerId: string, price: import("@hashgraph/sdk").Hbar, saleTxId: string }} sale
 * @param {object} plan from planSale
 */
export function saleEvent({ uaId, treasuryId, buyerId, price, saleTxId }, plan) {
  const isAchala = plan.tokenClass === "achala";
  return buildEvent(
    {
      event: "SALE",
      ...(isAchala && { stoneId: plan.achalaId }),
      tokenId: plan.tokenId,
      serials: [String(plan.nftId.serial)],
      actorId: uaId,
      ref: saleTxId,
    },
    {
      seller_id: String(treasuryId),
      buyer_id: String(buyerId),
      payment: "on_chain",
      sold_for: price.toBigNumber().toString(),
      currency: "HBAR",
      price_tinybars: price.toTinybars().toString(),
      ...(isAchala && achalaSaleFields(plan.stones, plan.uminaTokenId)),
    },
  );
}

/**
 * What follows a settled sale, from the command line or the site: SALE on the
 * provenance topic, then UNLISTED (reason "sold") on the display topic, so the
 * item leaves the catalog. It never throws: the sale has settled, so each step
 * that fails is returned with how to record it by hand. With `unlist: false`
 * (an item that was not listed, see saleChecks) only SALE is recorded.
 * @param {import("@hashgraph/sdk").Client} client UA's client
 * @param {Record<string, string | undefined>} env HCS_TOPIC_ID, HCS_DISPLAY_TOPIC_ID
 * @param {{ uaId: string, treasuryId: string, buyerId: string, price: import("@hashgraph/sdk").Hbar, saleTxId: string }} sale
 * @param {object} plan from planSale
 * @param {{ submitKey?: import("@hashgraph/sdk").PrivateKey | null, submit?: typeof submitEvent, unlist?: boolean }} [options]
 * @returns {Promise<{ saleEventTxId?: string, unlistedTxId?: string, problems: string[] }>}
 */
export async function recordSold(client, env, sale, plan, { submitKey = null, submit = submitEvent, unlist = true } = {}) {
  const out = { problems: [] };
  const serial = String(plan.nftId.serial);
  const token = plan.tokenClass === "achala" ? " --token achala" : "";
  try {
    out.saleEventTxId = await submit(client, env.HCS_TOPIC_ID, saleEvent(sale, plan), submitKey);
  } catch (err) {
    out.problems.push(
      `SALE was not recorded (${err.message}); record it by hand: recordEvent.js with the sale ${sale.saleTxId}`,
    );
  }
  if (!unlist) return out;
  try {
    const message = buildEvent(
      { event: "UNLISTED", stoneId: plan.stoneId, tokenId: plan.tokenId, serials: [serial], actorId: sale.uaId },
      displayFields({ command: "unlisted", reason: "sold" }),
    );
    out.unlistedTxId = await submit(client, env.HCS_DISPLAY_TOPIC_ID, message, submitKey);
  } catch (err) {
    out.problems.push(
      `UNLISTED was not posted (${err.message}); post it by hand: displayEvent.js unlisted ${serial}${token} --reason sold`,
    );
  }
  return out;
}
