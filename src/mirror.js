/**
 * @file mirror.js
 * @description Reads from the Hedera testnet mirror node (public REST API, no
 * key needed). Shared by the scripts that check the ledger before acting.
 */

export const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

/**
 * Reads every message on an HCS topic, oldest first, and returns the ones
 * that are JSON objects (events), each with its sequence number. Messages
 * that are not JSON are skipped. Throws when the topic does not exist.
 * @param {string} topicId
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<{ sequence_number: number, event: object }>>}
 */
export async function topicEvents(topicId, fetchFn = fetch) {
  const events = [];
  let next = `/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (next) {
    const response = await fetchFn(`${MIRROR_NODE}${next}`);
    if (response.status === 404) {
      throw new Error(`HCS topic ${topicId} was not found on the mirror node`);
    }
    if (!response.ok) {
      throw new Error(`mirror node request failed: ${response.status} ${await response.text()}`);
    }
    const page = await response.json();
    for (const { sequence_number, message } of page.messages ?? []) {
      try {
        const event = JSON.parse(Buffer.from(message, "base64").toString("utf8"));
        if (event && typeof event === "object") events.push({ sequence_number, event });
      } catch {
        // not an event
      }
    }
    next = page.links?.next ?? null;
  }
  return events;
}
