/**
 * @file hcs.js
 * @description Builds and submits HCS events, shared by every script that
 * records one (MINT, SALE, and later events). Messages follow the event
 * envelope in umina-achala-chain#10.
 *
 * A submission waits for the receipt, so an event that fails at consensus
 * (wrong signature, deleted or expired topic) is reported as a failure
 * instead of as a written record. When the topic has a submit key, the message
 * is signed with HCS_SUBMIT_KEY (umina-achala-chain#9, #17).
 */

import { TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import { parseEcdsaKey } from "./keys.js";

/** Version of the event message shapes. Bump when a shape changes. */
export const SCHEMA_VERSION = 1;

/** HCS limit for one message (one chunk), in bytes. */
export const MAX_MESSAGE_BYTES = 1024;

/** Formats a time as UTC to the second, e.g. 2026-10-27T15:00:00Z. */
export function utcSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Builds an event message with the envelope fields first, then the
 * event-specific fields. `stoneId` and `ref` are left out when not given.
 * Throws when the message would not fit in one HCS message.
 * @param {object} envelope
 * @param {string} envelope.event event type, e.g. "MINT" or "SALE"
 * @param {string} [envelope.stoneId]
 * @param {string} envelope.tokenId
 * @param {Array<string|number>} envelope.serials
 * @param {string} envelope.actorId account that submits the event
 * @param {Date} [envelope.occurredAt] when it happened, defaults to now
 * @param {string} [envelope.ref] related Hedera transaction ID
 * @param {object} [fields] event-specific fields
 */
export function buildEvent(
  { event, stoneId, tokenId, serials, actorId, occurredAt = new Date(), ref },
  fields = {},
) {
  const message = {
    event,
    schema_version: SCHEMA_VERSION,
    ...(stoneId && { stone_id: stoneId }),
    token_id: String(tokenId),
    serials: serials.map(String),
    actor_id: String(actorId),
    occurred_at: utcSeconds(occurredAt),
    ...(ref && { ref: String(ref) }),
    ...fields,
  };
  const bytes = Buffer.byteLength(JSON.stringify(message));
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `${event} message is ${bytes} bytes, over the ${MAX_MESSAGE_BYTES}-byte HCS limit`,
    );
  }
  return message;
}

/**
 * Returns a problem message when HCS_SUBMIT_KEY is set but is not an ECDSA
 * private key, or null. The key is optional: a topic without a submit key
 * accepts messages signed by the operator alone.
 */
export function submitKeyProblem(env) {
  if (!env.HCS_SUBMIT_KEY) return null;
  try {
    parseEcdsaKey(env.HCS_SUBMIT_KEY);
    return null;
  } catch {
    return "HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)";
  }
}

/** Returns the submit key from the environment, or null when it is not set. */
export function loadSubmitKey(env) {
  return env.HCS_SUBMIT_KEY ? parseEcdsaKey(env.HCS_SUBMIT_KEY) : null;
}

/**
 * Submits an event to a topic, signed with the submit key when one is given,
 * and waits for the receipt. Returns the transaction ID. Throws when the
 * network rejects the message, including at consensus.
 * @param {import("@hashgraph/sdk").Client} client
 * @param {string} topicId
 * @param {object} message from buildEvent
 * @param {import("@hashgraph/sdk").PrivateKey | null} [submitKey]
 * @returns {Promise<string>}
 */
export async function submitEvent(client, topicId, message, submitKey = null) {
  let tx = new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(JSON.stringify(message))
    .freezeWith(client);
  if (submitKey) tx = await tx.sign(submitKey);
  const response = await tx.execute(client);
  await response.getReceipt(client);
  return response.transactionId.toString();
}
