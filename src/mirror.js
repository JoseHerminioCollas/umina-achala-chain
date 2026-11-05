/**
 * @file mirror.js
 * @description Reads from the Hedera testnet mirror node (public REST API, no
 * key needed). Shared by the scripts that check the ledger before acting.
 */

export const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

const TX_ID = /^(0\.0\.\d+)[@-](\d+)[.-](\d{1,9})$/;

/**
 * Normalizes a transaction ID to the SDK form, 0.0.1001@1700000000.000000005,
 * from either that form (nanoseconds padded or not) or the mirror node form,
 * 0.0.1001-1700000000-000000005. Returns null when it is not a transaction ID.
 */
export function normalizeTxId(id) {
  const m = TX_ID.exec(String(id ?? "").trim());
  return m ? `${m[1]}@${m[2]}.${m[3].padStart(9, "0")}` : null;
}

/** The mirror node form of a transaction ID (see normalizeTxId). */
export function mirrorTxId(id) {
  const sdk = normalizeTxId(id);
  return sdk && sdk.replace("@", "-").replace(/\.(\d{9})$/, "-$1");
}

/** GETs a mirror node path; returns the JSON, or null on 404. */
async function getJson(pathAndQuery, fetchFn) {
  const response = await fetchFn(`${MIRROR_NODE}${pathAndQuery}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`mirror node request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * Returns the main record of a transaction (transfers, nft_transfers,
 * result, consensus_timestamp, charged_tx_fee), or null when the mirror node
 * does not know it. Child records (such as royalty payments made by a smart
 * contract) are not included.
 * @param {string} txId either form (see normalizeTxId)
 * @param {typeof fetch} [fetchFn]
 */
export async function transactionRecord(txId, fetchFn = fetch) {
  const id = mirrorTxId(txId);
  if (!id) throw new Error(`not a transaction ID: "${txId}"`);
  const body = await getJson(`/api/v1/transactions/${id}`, fetchFn);
  const records = body?.transactions ?? [];
  return records.find((r) => !r.parent_consensus_timestamp) ?? records[0] ?? null;
}

/**
 * Returns an NFT's current state (account_id is the holder, deleted), or null
 * when the serial does not exist.
 */
export async function nftInfo(tokenId, serial, fetchFn = fetch) {
  return getJson(`/api/v1/tokens/${tokenId}/nfts/${serial}`, fetchFn);
}

/**
 * Returns an account's public key as the mirror node gives it,
 * { _type: "ECDSA_SECP256K1" | "ED25519" | "ProtobufEncoded", key }, or null
 * when the account does not exist.
 */
export async function accountKey(accountId, fetchFn = fetch) {
  const body = await getJson(`/api/v1/accounts/${accountId}`, fetchFn);
  return body ? body.key : null;
}

/**
 * Returns a topic's details from the mirror node (memo, keys, deleted), or
 * null when the topic does not exist.
 * @param {string} topicId
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object | null>}
 */
export async function topicInfo(topicId, fetchFn = fetch) {
  return getJson(`/api/v1/topics/${topicId}`, fetchFn);
}

/**
 * Reads every message on an HCS topic, oldest first, and returns the ones
 * that are JSON objects (events), each with its sequence number. Messages
 * that are not JSON are skipped. Throws when the topic does not exist or is
 * deleted.
 * @param {string} topicId
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<{ sequence_number: number, event: object }>>}
 */
export async function topicEvents(topicId, fetchFn = fetch) {
  // The messages endpoint answers 200 with no messages for a topic that does
  // not exist, so look the topic itself up first.
  const info = await topicInfo(topicId, fetchFn);
  if (!info || info.deleted) {
    throw new Error(`HCS topic ${topicId} was not found on the mirror node`);
  }
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
