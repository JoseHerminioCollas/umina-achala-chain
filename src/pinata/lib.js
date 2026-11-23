/**
 * @file pinata/lib.js
 * @description Finds the IPFS files of burned NFTs that no NFT still uses,
 * and unpins them from Pinata (unpinBurned.js). A burned NFT's metadata stays
 * on the mirror node, so its files can be found after the burn. The same file
 * can belong to a burned NFT and to one that still exists (a document pinned
 * again for a new mint has the same CID), so a CID any existing NFT uses is
 * never unpinned.
 */

import { cidOfNftMetadata, ipfsPathOfUri } from "../ipfs.js";

export const PINATA_UNPIN = "https://api.pinata.cloud/pinning/unpin";

/** The CID of an ipfs://<cid> or ipfs://<cid>/<file> URI, or null. */
export function cidOf(uri) {
  const path = ipfsPathOfUri(uri);
  return path ? path.split("/")[0] : null;
}

/**
 * Every CID an NFT uses: its metadata file, `image` and each of `files`.
 * `metadata` is the JSON, or null when it could not be read (then only the
 * metadata file's CID is known).
 * @param {string | null} metadataCid
 * @param {{ image?: string, files?: Array<{ uri?: string }> } | null} metadata
 * @returns {string[]}
 */
export function nftCids(metadataCid, metadata) {
  const uris = metadata ? [metadata.image, ...(metadata.files ?? []).map((f) => f?.uri)] : [];
  const cids = [metadataCid, ...uris.map(cidOf)].filter(Boolean);
  return [...new Set(cids)];
}

/**
 * The CIDs used only by burned NFTs, each with the NFTs that used it, in the
 * order first seen.
 * @param {Array<{ label: string, deleted: boolean, cids: string[] }>} nfts
 * @returns {Array<{ cid: string, nfts: string[] }>}
 */
export function orphanCids(nfts) {
  const kept = new Set(nfts.filter((n) => !n.deleted).flatMap((n) => n.cids));
  const orphans = new Map();
  for (const nft of nfts.filter((n) => n.deleted)) {
    for (const cid of nft.cids) {
      if (kept.has(cid)) continue;
      if (!orphans.has(cid)) orphans.set(cid, []);
      orphans.get(cid).push(nft.label);
    }
  }
  return [...orphans].map(([cid, labels]) => ({ cid, nfts: labels }));
}

/**
 * Maps over the items with at most `limit` calls running at once, keeping
 * the order. Reading 30 metadata files one by one through a public gateway
 * takes minutes.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The metadata CID of a mirror node NFT (its metadata is base64 of the ipfs:// URI). */
export function mirrorNftCid(nft) {
  return cidOfNftMetadata(nft.metadata);
}

/** How long a Pinata API call may take before it is given up. */
export const PINATA_TIMEOUT_MS = 30000;

/**
 * Unpins a CID from the Pinata account. Returns "unpinned", or "not pinned"
 * when the account does not pin it (already unpinned, or pinned by another
 * account): Pinata answers that with a 4xx naming the CID as not pinned. It
 * needs only the key's `unpin` scope; no pin list is read, since UA's key may
 * not be allowed to list pins and a list search can be slow.
 * @returns {Promise<"unpinned" | "not pinned">}
 */
export async function unpin(cid, jwt, fetchFn = fetch, timeoutMs = PINATA_TIMEOUT_MS) {
  const response = await fetchFn(`${PINATA_UNPIN}/${encodeURIComponent(cid)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.ok) return "unpinned";
  const text = await response.text();
  if ((response.status === 400 || response.status === 404) && /not pinned|NOT_PINNED|not found/i.test(text)) {
    return "not pinned";
  }
  throw new Error(`Pinata unpin of ${cid} failed: ${response.status} ${text}`);
}
