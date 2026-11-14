/**
 * @file record/proof.js
 * @description Proof of delivery for recordEvent.js delivered
 * (umina-achala-chain#8): the message the buyer signs with the wallet that
 * received the NFT, the prefix Hedera wallets add before signing, and the
 * check of a signed proof file against the buyer's account key.
 */

import crypto from "crypto";
import { PublicKey } from "@hashgraph/sdk";
import ua from "../../config/umina-achala.js";

/**
 * The message a buyer signs with the wallet that received the NFT, as proof
 * of delivery. It names the token, serial and account, so a signature for one
 * item cannot be reused for another.
 */
export function deliveryProofMessage(tokenId, serial, buyerId) {
  return `${ua.name} delivery: account ${buyerId} received token ${tokenId} serial ${serial}.`;
}

/**
 * Hedera wallets prefix a message before signing it (hedera_signMessage):
 * "\x19Hedera Signed Message:\n" + its length + the message.
 */
export function hederaSignedMessage(message) {
  return `\x19Hedera Signed Message:\n${Buffer.byteLength(message)}${message}`;
}

/**
 * Checks a proof file ({ "message": ..., "signature": "<hex>" }) against the
 * expected message and the buyer's public key from the mirror node. Accepts a
 * signature over the message itself or over the wallet-prefixed form.
 * @param {Buffer|string} fileContent
 * @param {string} expectedMessage
 * @param {{ _type: string, key: string } | null} keyInfo
 * @returns {{ problem: string | null, proofHash?: string }}
 */
export function checkProof(fileContent, expectedMessage, keyInfo) {
  let proof;
  try {
    proof = JSON.parse(String(fileContent));
  } catch {
    return { problem: "the proof file is not JSON" };
  }
  if (typeof proof?.message !== "string" || typeof proof?.signature !== "string") {
    return { problem: 'the proof file needs "message" and "signature" (hex)' };
  }
  if (proof.message !== expectedMessage) {
    return { problem: `the proof message is not the delivery message: "${expectedMessage}"` };
  }
  if (!keyInfo) return { problem: "the mirror node does not know the buyer's account" };
  let publicKey;
  try {
    if (keyInfo._type === "ECDSA_SECP256K1") publicKey = PublicKey.fromStringECDSA(keyInfo.key);
    else if (keyInfo._type === "ED25519") publicKey = PublicKey.fromStringED25519(keyInfo.key);
    else return { problem: `the buyer's account key type ${keyInfo._type} is not supported for proofs` };
  } catch {
    return { problem: "the buyer's account key could not be read" };
  }
  const signature = Buffer.from(proof.signature.replace(/^0x/, ""), "hex");
  const signed = [proof.message, hederaSignedMessage(proof.message)].some((m) => {
    try {
      return publicKey.verify(Buffer.from(m), signature);
    } catch {
      return false;
    }
  });
  if (!signed) return { problem: "the proof signature does not match the buyer's account key" };
  return {
    problem: null,
    proofHash: crypto.createHash("sha256").update(fileContent).digest("hex"),
  };
}
