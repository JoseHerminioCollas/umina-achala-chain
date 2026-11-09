/**
 * @file consignment/lib.js
 * @description Helpers for the Umiña consignment scripts (associateToken.js,
 * consignToMerchant.js, sellConsigned.js). See
 * umina-achala-documents/consignment.md.
 */

import {
  ReceiptStatusError,
  Status,
  TokenAssociateTransaction,
} from "@hashgraph/sdk";
import { ROYALTY, TOKEN_CLASSES } from "../token/lib.js";
import { envProblems, serialProblem } from "../env.js";

/** Test accounts that can associate the token, by role (env var prefix). */
export const ROLES = { merchant: "MERCHANT", buyer: "BUYER" };

/**
 * UA's commission on a sale through UA's site, in basis points (30.00%). It
 * includes the token's royalty (umina-achala-web#90, decided 2026-11-09).
 */
export const UA_SHARE_BPS = 3000n;

/**
 * Splits a price in tinybars into the two payment legs of a consigned sale, so
 * that after the royalty the merchant ends with 70% and UA with 30%
 * (umina-achala-chain#30).
 *
 * HTS takes the royalty from what the NFT's sender receives, which is the
 * merchant, and pays it to the Treasury (UA). So the merchant's leg is
 * 70% / (1 - royalty): on 100 HBAR, 73.68 to the merchant and 26.32 to UA;
 * the 5% royalty then moves 3.68 to UA, leaving 70 and 30.
 *
 * Integer math: the legs add up to the price exactly, and the merchant's leg
 * is rounded up, so any rounding remainder goes to the merchant. The royalty
 * and the results after it assume HTS rounds the royalty down; check on
 * testnet (umina-achala-chain#22).
 * @param {bigint} priceTinybars
 * @param {{ numerator: number, denominator: number }} [royalty] the token's royalty
 * @returns {{ merchant: bigint, ua: bigint, royalty: bigint, merchantNet: bigint, uaNet: bigint }}
 *   merchant and ua are the legs paid in the transfer; royalty is what HTS
 *   moves from the merchant to UA; merchantNet and uaNet are what each ends with
 */
export function consignmentSplit(priceTinybars, royalty = ROYALTY) {
  if (typeof priceTinybars !== "bigint" || priceTinybars <= 0n) {
    throw new Error("price must be a positive bigint of tinybars");
  }
  const num = BigInt(royalty.numerator);
  const den = BigInt(royalty.denominator);
  // merchant leg = price * (1 - UA share) / (1 - royalty), rounded up
  const top = priceTinybars * (10000n - UA_SHARE_BPS) * den;
  const bottom = 10000n * (den - num);
  const merchant = (top + bottom - 1n) / bottom;
  const ua = priceTinybars - merchant;
  const royaltyTinybars = (merchant * num) / den;
  return {
    merchant,
    ua,
    royalty: royaltyTinybars,
    merchantNet: merchant - royaltyTinybars,
    uaNet: ua + royaltyTinybars,
  };
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
 * Lists the problems with associateToken.js's role and environment.
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} role "merchant" or "buyer"
 * @param {"umina" | "achala"} [tokenClass] the token to associate
 * @returns {string[]}
 */
export function roleProblems(env, role, tokenClass = "umina") {
  const prefix = ROLES[role];
  if (!prefix) return [`give the role: ${Object.keys(ROLES).join(" or ")}`];
  return envProblems(env, [
    "OPERATOR_ID",
    "OPERATOR_KEY",
    TOKEN_CLASSES[tokenClass].envVar,
    `${prefix}_ID`,
    `${prefix}_KEY`,
  ]);
}

/**
 * Associates an account with a token, signed by that account's key. The
 * client's operator pays the fee.
 * @param {import("@hashgraph/sdk").Client} client
 * @param {import("@hashgraph/sdk").AccountId} accountId
 * @param {import("@hashgraph/sdk").PrivateKey} accountKey
 * @param {import("@hashgraph/sdk").TokenId} tokenId
 * @returns {Promise<boolean>} false when the account was already associated
 */
export async function associateToken(client, accountId, accountKey, tokenId) {
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([tokenId])
      .freezeWith(client)
      .sign(accountKey);
    await (await tx.execute(client)).getReceipt(client);
    return true;
  } catch (err) {
    if (err instanceof ReceiptStatusError && err.status === Status.TokenAlreadyAssociatedToAccount) {
      return false;
    }
    throw err;
  }
}
