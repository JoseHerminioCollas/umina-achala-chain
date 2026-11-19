/**
 * @file ipfs.js
 * @description Reads a JSON file from IPFS through a gateway (the catalog
 * builder, umina-achala-chain#44). Public gateways are slow and refuse
 * requests at times, so each read is tried a few times.
 */

import config from "../config/umina-achala.js";

const IPFS_URI = /^ipfs:\/\/([A-Za-z0-9]+)$/;

/** The gateway: IPFS_GATEWAY when set, else UA's default, ending in "/". */
export function ipfsGateway(env = process.env) {
  const gateway = env.IPFS_GATEWAY || config.ipfsGateway;
  return gateway.endsWith("/") ? gateway : `${gateway}/`;
}

/** The CID of an ipfs://<cid> URI, or null when it is not one. */
export function cidOfUri(uri) {
  const m = IPFS_URI.exec(String(uri ?? "").trim());
  return m ? m[1] : null;
}

/** The CID in an NFT's on-chain metadata as the mirror node gives it (base64), or null. */
export function cidOfNftMetadata(base64) {
  if (typeof base64 !== "string") return null;
  return cidOfUri(Buffer.from(base64, "base64").toString("utf8"));
}

/** Thrown when a file was read but is not JSON: a problem with the file, not the gateway. */
export class NotJsonError extends Error {}

/**
 * Reads the JSON file with this CID through the gateway. A failed request
 * (network error, timeout or a status other than 200) is tried again, up to
 * `tries` times in all, waiting longer each time; then it throws. A file that
 * is not JSON throws NotJsonError at once.
 * @param {string} cid
 * @param {{ gateway?: string, fetchFn?: typeof fetch, tries?: number, waitMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<any>}
 */
export async function fetchIpfsJson(
  cid,
  {
    gateway = ipfsGateway(),
    fetchFn = fetch,
    tries = 3,
    waitMs = 2000,
    timeoutMs = 30000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const url = `${gateway}${cid}`;
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let text;
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
    } catch (err) {
      lastError = err;
      if (attempt < tries) await sleep(waitMs * attempt);
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new NotJsonError(`${url} is not JSON`);
    }
  }
  throw new Error(`cannot read ${url} after ${tries} tries: ${lastError.message}`);
}
