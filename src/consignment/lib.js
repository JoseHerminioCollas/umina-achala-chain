/**
 * @file consignment/lib.js
 * @description Helpers for the consignment scripts (consignToMerchant.js,
 * sellConsigned.js, endConsignment.js), for an Umiña or
 * an Achala with its stones (umina-achala-chain#28). See
 * umina-achala-documents/consignment.md.
 */

import { NftId, TokenId } from "@hashgraph/sdk";
import { ROYALTY } from "../token/lib.js";
import { envProblems, serialProblem } from "../env.js";
import { achalaSaleFields, achalaSalePlan, mountedProblem } from "../mint/achala.js";
import { mountIds } from "../provenance.js";
import ua from "../../config/umina-achala.js";

/**
 * UA's commission on a sale through UA's site, in basis points (30.00%). It
 * includes the token's royalty (config/umina-achala.js, umina-achala-web#90).
 */
export const UA_SHARE_BPS = ua.commissionBps;

/**
 * Splits a price in tinybars into the two payment legs of a consigned sale, so
 * that after the royalty the merchant ends with 70% and UA with 30%
 * (umina-achala-chain#30).
 *
 * HTS takes the royalty from what the NFT's sender receives, which is the
 * merchant, and pays it to the Treasury (UA). It does so once per token among
 * the NFTs that move, each time on the merchant's whole leg (testnet,
 * umina-achala-chain#22, #28): an Umiña alone pays one royalty, an Achala with
 * any number of stones pays two (the Achala token and the Umiña token), and
 * stones of the same token share one. So the merchant's leg is
 * 70% / (1 - royalties × royalty): on 100 HBAR, an Umiña gives 73.68 to the
 * merchant and 26.32 to UA, the royalty moves 3.68 to UA, leaving 70 and 30;
 * an Achala gives 77.78 and 22.22, two royalties move 7.78, leaving 70 and 30.
 *
 * Integer math: the legs add up to the price exactly, and the merchant's leg
 * is rounded up, so any rounding remainder goes to the merchant. Each royalty
 * is rounded down, as HTS does (checked on testnet).
 * @param {bigint} priceTinybars
 * @param {{ numerator: number, denominator: number }} [royalty] each token's royalty
 * @param {number} [royalties] how many royalties HTS charges: the number of
 *   tokens among the NFTs that move (royaltyCount)
 * @returns {{ merchant: bigint, ua: bigint, royalty: bigint, royalties: number, merchantNet: bigint, uaNet: bigint }}
 *   merchant and ua are the legs paid in the transfer; royalty is what HTS
 *   moves from the merchant to UA in all; merchantNet and uaNet are what each ends with
 */
export function consignmentSplit(priceTinybars, royalty = ROYALTY, royalties = 1) {
  if (typeof priceTinybars !== "bigint" || priceTinybars <= 0n) {
    throw new Error("price must be a positive bigint of tinybars");
  }
  if (!Number.isInteger(royalties) || royalties < 1) {
    throw new Error("royalties must be a positive whole number");
  }
  const num = BigInt(royalty.numerator);
  const den = BigInt(royalty.denominator);
  const k = BigInt(royalties);
  if (k * num >= den) throw new Error("the royalties would take the merchant's whole leg");
  // merchant leg = price * (1 - UA share) / (1 - k * royalty), rounded up
  const top = priceTinybars * (10000n - UA_SHARE_BPS) * den;
  const bottom = 10000n * (den - k * num);
  const merchant = (top + bottom - 1n) / bottom;
  const ua = priceTinybars - merchant;
  const royaltyTinybars = k * ((merchant * num) / den);
  return {
    merchant,
    ua,
    royalty: royaltyTinybars,
    royalties,
    merchantNet: merchant - royaltyTinybars,
    uaNet: ua + royaltyTinybars,
  };
}

/**
 * How many royalties HTS charges when these NFTs move together for one
 * payment: one per token among them (umina-achala-chain#28).
 * @param {Array<{ tokenId: { toString(): string } }>} nftIds
 * @returns {number}
 */
export function royaltyCount(nftIds) {
  return new Set(nftIds.map((id) => id.tokenId.toString())).size;
}

/**
 * Lists the problems with a consignment script's environment and serial.
 * @param {Record<string, string | undefined>} env
 * @param {string[]} required names of the variables that must be set
 * @param {string | undefined} serial
 * @returns {string[]}
 */
export function consignmentProblems(env, required, serial) {
  const problems = envProblems(env, required);
  const bad = serialProblem(serial);
  if (bad) problems.push(bad);
  return problems;
}

/**
 * What a consignment script moves for one serial, from the provenance topic
 * (umina-achala-chain#28):
 * - an Umiña: that serial, refused while it is mounted in an Achala that
 *   still exists; it moves only with its Achala (#24)
 * - an Achala: the Achala and every Umiña stone in it (from its MINT), in
 *   one transfer, as in the Achala sale (#26)
 * Returns the problems (empty when the script can go on), the NFTs, and what
 * the event adds for an Achala: its stone_id, and its stones with their
 * Umiña serials.
 * @param {object[]} events the provenance topic's events
 * @param {Record<string, string | undefined>} env
 * @param {string} serial
 * @param {"umina" | "achala"} [tokenClass]
 * @returns {{ problems: string[], nftIds?: NftId[], stoneId?: string, fields?: object, stones?: object[] }}
 */
export function consignmentNfts(events, env, serial, tokenClass = "umina") {
  const ids = mountIds(env, serial);
  const nft = (tokenVar, s) => new NftId(TokenId.fromString(env[tokenVar]), Number(s));
  if (tokenClass === "achala") {
    const plan = achalaSalePlan(events, ids);
    if (plan.problems.length) return { problems: plan.problems };
    return {
      problems: [],
      nftIds: [nft("ACHALA_TOKEN_ID", serial), ...plan.stones.map((s) => nft("UMINA_TOKEN_ID", s.serial))],
      stoneId: plan.achalaId,
      fields: achalaSaleFields(plan.stones, env.UMINA_TOKEN_ID),
      stones: plan.stones,
    };
  }
  const mounted = mountedProblem(events, ids);
  if (mounted) return { problems: [mounted] };
  return { problems: [], nftIds: [nft("UMINA_TOKEN_ID", serial)], fields: {}, stones: [] };
}
