/**
 * @file mirror.js
 * @description Reads from the mirror node of the network (testnet unless
 * NETWORK says otherwise; public REST API, no
 * key needed). Shared by the scripts that check the ledger before acting.
 */

import { mirrorNode } from "./network.js";

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
  const response = await fetchFn(`${mirrorNode()}${pathAndQuery}`);
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
 * that are JSON objects (events), each with its sequence number and, when the
 * mirror node gives it, its consensus timestamp. Messages
 * that are not JSON are skipped. Throws when the topic does not exist or is
 * deleted.
 * @param {string} topicId
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<{ sequence_number: number, consensus_timestamp?: string, event: object }>>}
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
    const response = await fetchFn(`${mirrorNode()}${next}`);
    if (response.status === 404) {
      throw new Error(`HCS topic ${topicId} was not found on the mirror node`);
    }
    if (!response.ok) {
      throw new Error(`mirror node request failed: ${response.status} ${await response.text()}`);
    }
    const page = await response.json();
    for (const { sequence_number, consensus_timestamp, message } of page.messages ?? []) {
      try {
        const event = JSON.parse(Buffer.from(message, "base64").toString("utf8"));
        if (event && typeof event === "object") {
          events.push({ sequence_number, ...(consensus_timestamp && { consensus_timestamp }), event });
        }
      } catch {
        // not an event
      }
    }
    next = page.links?.next ?? null;
  }
  return events;
}

/**
 * Every NFT of a token, burned ones included (deleted), in serial order,
 * following the mirror node's pages. Each has serial_number, account_id (the
 * holder), deleted and metadata (base64 of the ipfs:// URI) (#44).
 * @param {string} tokenId
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<{ serial_number: number, account_id: string | null, deleted: boolean, metadata: string }>>}
 */
export async function tokenNfts(tokenId, fetchFn = fetch) {
  const nfts = [];
  let next = `/api/v1/tokens/${tokenId}/nfts?limit=100&order=asc`;
  while (next) {
    const page = await getJson(next, fetchFn);
    if (!page) throw new Error(`token ${tokenId} was not found on the mirror node`);
    nfts.push(...(page.nfts ?? []));
    next = page.links?.next ?? null;
  }
  return nfts;
}

/**
 * Every NFT of a token that an account holds now (not burned), following the
 * mirror node's pages.
 * @param {string} accountId
 * @param {string} tokenId
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<{ serial_number: number, account_id: string, deleted: boolean }>>}
 */
export async function accountNfts(accountId, tokenId, fetchFn = fetch) {
  const nfts = [];
  let next = `/api/v1/accounts/${accountId}/nfts?token.id=${tokenId}&limit=100`;
  while (next) {
    const page = await getJson(next, fetchFn);
    if (!page) throw new Error(`account ${accountId} was not found on the mirror node`);
    nfts.push(...(page.nfts ?? []).filter((nft) => !nft.deleted));
    next = page.links?.next ?? null;
  }
  return nfts;
}

/**
 * The consensus timestamp of the latest transaction that moved an NFT into
 * an account (its mint, for the treasury, or a transfer), or null when the
 * mirror node shows none. Used to tell a listing made before the NFT left and
 * came back from one made since (umina-achala-chain#43).
 * @param {string} tokenId
 * @param {string|number} serial
 * @param {string} accountId
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string | null>} e.g. "1700000000.123456789"
 */
export async function latestArrival(tokenId, serial, accountId, fetchFn = fetch) {
  let next = `/api/v1/tokens/${tokenId}/nfts/${serial}/transactions?limit=25&order=desc`;
  while (next) {
    const page = await getJson(next, fetchFn);
    if (!page) return null;
    const arrival = (page.transactions ?? []).find((t) => t.receiver_account_id === accountId);
    if (arrival) return arrival.consensus_timestamp;
    next = page.links?.next ?? null;
  }
  return null;
}

/**
 * Whether an account can receive a token's NFTs (umina-achala-web#116): its
 * key, and for each token whether it is associated, or whether the account
 * associates new tokens on its own (max_automatic_token_associations -1, or
 * a free slot left), and its HBAR balance in tinybars (null when the mirror
 * node does not give it). Returns null when the account does not exist.
 * @param {string} accountId
 * @param {string[]} tokenIds
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ key: { _type: string, key: string } | null, notAssociated: string[], balance: number | null } | null>}
 */
export async function buyerAccount(accountId, tokenIds, fetchFn = fetch) {
  const account = await getJson(`/api/v1/accounts/${accountId}`, fetchFn);
  if (!account) return null;
  const max = account.max_automatic_token_associations ?? 0;
  const notAssociated = [];
  let autoUsed = null;
  for (const tokenId of tokenIds) {
    const page = await getJson(`/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`, fetchFn);
    if ((page?.tokens ?? []).length) continue;
    if (max === -1) continue;
    if (max > 0) {
      // automatic slots in use: the account's associations made automatically
      autoUsed ??= await countAutoAssociations(accountId, fetchFn);
      if (autoUsed < max) {
        autoUsed++;
        continue;
      }
    }
    notAssociated.push(tokenId);
  }
  return { key: account.key ?? null, notAssociated, balance: account.balance?.balance ?? null };
}

async function countAutoAssociations(accountId, fetchFn) {
  let count = 0;
  let next = `/api/v1/accounts/${accountId}/tokens?limit=100`;
  while (next) {
    const page = await getJson(next, fetchFn);
    count += (page?.tokens ?? []).filter((t) => t.automatic_association).length;
    next = page?.links?.next ?? null;
  }
  return count;
}
