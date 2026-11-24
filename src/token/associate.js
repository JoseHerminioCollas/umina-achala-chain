/**
 * @file token/associate.js
 * @description Associating a token with an account, which must happen before
 * the account can receive one of its NFTs (any sale, consignment or
 * transfer): associateToken.js for the merchant and buyer test accounts, and
 * consignToMerchant.js for the merchant. Also the token ID variables a
 * script needs for a token class.
 */

import { ReceiptStatusError, Status, TokenAssociateTransaction } from "@hashgraph/sdk";
import { envProblems } from "../env.js";

/** Test accounts that can associate the token, by role (env var prefix). */
export const ROLES = { merchant: "MERCHANT", buyer: "BUYER" };

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
    ...tokenVars(tokenClass),
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

/**
 * The token ID variables a script needs for a class (association, consignment): an Achala
 * also needs UMINA_TOKEN_ID, since its stones move with it (#28).
 */
export function tokenVars(tokenClass = "umina") {
  return tokenClass === "achala" ? ["UMINA_TOKEN_ID", "ACHALA_TOKEN_ID"] : ["UMINA_TOKEN_ID"];
}
