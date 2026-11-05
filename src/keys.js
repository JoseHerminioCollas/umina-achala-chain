/**
 * @file keys.js
 * @description Key parsing shared by every script.
 */

import { PrivateKey } from "@hashgraph/sdk";

/**
 * Parses an ECDSA private key given as raw 64-character hex or as DER. DER
 * input is checked for its type, because fromStringECDSA accepts an ED25519
 * DER key without complaint and it would only fail later when signing.
 */
export function parseEcdsaKey(value) {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    return PrivateKey.fromStringECDSA(value);
  }
  const key = PrivateKey.fromStringDer(value);
  if (key.type !== "secp256k1") {
    throw new Error(`expected an ECDSA key, got ${key.type}`);
  }
  return key;
}

/**
 * Returns a problem message about TREASURY_KEY, or null. It is needed only
 * when the treasury is not the operator account, because a transfer out of
 * the treasury must then be signed by the treasury's own key.
 */
export function treasuryKeyProblem(env) {
  if (env.TREASURY_ID === env.OPERATOR_ID) return null;
  if (!env.TREASURY_KEY) return "TREASURY_KEY is required when TREASURY_ID is not OPERATOR_ID";
  try {
    parseEcdsaKey(env.TREASURY_KEY);
    return null;
  } catch {
    return "TREASURY_KEY is not an ECDSA private key (hex or DER)";
  }
}
