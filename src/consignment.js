/**
 * @file consignment.js
 * @description Helpers for the Umiña consignment scripts (associateToken.js,
 * consignToMerchant.js, sellConsigned.js). See
 * umina-achala-documents/consignment.md.
 */

import {
  ReceiptStatusError,
  Status,
  TokenAssociateTransaction,
} from "@hashgraph/sdk";

/** Test accounts that can associate the token, by role (env var prefix). */
export const ROLES = { merchant: "MERCHANT", buyer: "BUYER" };

/** UA's commission on a primary sale, in basis points (30.00%). */
export const UA_SHARE_BPS = 3000n;

/**
 * Splits a price in tinybars into the merchant's and UA's shares. Integer math,
 * so the shares always add up to the price exactly; any odd tinybar goes to
 * the merchant. HTS takes the royalty from the merchant's share on top of this.
 * @param {bigint} priceTinybars
 * @returns {{ merchant: bigint, ua: bigint }}
 */
export function consignmentSplit(priceTinybars) {
  if (typeof priceTinybars !== "bigint" || priceTinybars <= 0n) {
    throw new Error("price must be a positive bigint of tinybars");
  }
  const ua = (priceTinybars * UA_SHARE_BPS) / 10000n;
  return { merchant: priceTinybars - ua, ua };
}

/**
 * Lists the problems with a consignment script's environment and serial.
 * @param {Record<string, string | undefined>} env
 * @param {string[]} required names of the variables that must be set
 * @param {string | undefined} serial
 * @returns {string[]}
 */
export function consignmentProblems(env, required, serial) {
  const problems = required.filter((k) => !env[k]).map((k) => `${k} is not set`);
  if (!/^[1-9]\d*$/.test(serial ?? "")) {
    problems.push("give the NFT serial number as a positive integer");
  }
  return problems;
}

/**
 * Lists the problems with associateToken.js's role and environment.
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} role "merchant" or "buyer"
 * @returns {string[]}
 */
export function roleProblems(env, role) {
  const prefix = ROLES[role];
  if (!prefix) return [`give the role: ${Object.keys(ROLES).join(" or ")}`];
  return ["OPERATOR_ID", "OPERATOR_KEY", "UMINA_TOKEN_ID", `${prefix}_ID`, `${prefix}_KEY`]
    .filter((k) => !env[k])
    .map((k) => `${k} is not set`);
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
