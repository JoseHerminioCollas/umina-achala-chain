/**
 * @file ipfs.js
 * @description Reads a file from IPFS through a gateway, as JSON (the catalog
 * builder's metadata, umina-achala-chain#44) or as bytes (its photos, #45).
 * Public gateways are slow and refuse requests at times, so each read is
 * tried a few times.
 */

import config from "../config/umina-achala.js";

const IPFS_URI = /^ipfs:\/\/([A-Za-z0-9]+)$/;
const IPFS_PATH_URI = /^ipfs:\/\/([A-Za-z0-9]+(?:\/[A-Za-z0-9._-]+)*)$/;

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

/**
 * The IPFS path of an ipfs://<cid> or ipfs://<cid>/<file> URI, or null when it
 * is not one. Only letters, digits, ".", "_" and "-" in a file name, and no
 * "." or ".." segment, so the path is also safe as a folder name.
 */
export function ipfsPathOfUri(uri) {
  const m = IPFS_PATH_URI.exec(String(uri ?? "").trim());
  if (!m || m[1].split("/").some((s) => s === "." || s === "..")) return null;
  return m[1];
}

/** The CID in an NFT's on-chain metadata as the mirror node gives it (base64), or null. */
export function cidOfNftMetadata(base64) {
  if (typeof base64 !== "string") return null;
  return cidOfUri(Buffer.from(base64, "base64").toString("utf8"));
}

/** Thrown when a file was read but is not JSON: a problem with the file, not the gateway. */
export class NotJsonError extends Error {}

/**
 * Reads one file through the gateway with `read(response)`. A failed request
 * (network error, timeout or a status other than 200) is tried again, up to
 * `tries` times in all, waiting longer each time; then it throws.
 */
async function readThroughGateway(
  path,
  read,
  {
    gateway = ipfsGateway(),
    fetchFn = fetch,
    tries = 3,
    waitMs = 2000,
    timeoutMs = 30000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const url = `${gateway}${path}`;
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { url, body: await read(response) };
    } catch (err) {
      lastError = err;
      if (attempt < tries) await sleep(waitMs * attempt);
    }
  }
  throw new Error(`cannot read ${url} after ${tries} tries: ${lastError.message}`);
}

/**
 * Reads the JSON file with this CID through the gateway, with retries (see
 * readThroughGateway). A file that is not JSON throws NotJsonError at once.
 * @param {string} cid
 * @param {{ gateway?: string, fetchFn?: typeof fetch, tries?: number, waitMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<any>}
 */
export async function fetchIpfsJson(cid, options) {
  const { url, body } = await readThroughGateway(cid, (r) => r.text(), options);
  try {
    return JSON.parse(body);
  } catch {
    throw new NotJsonError(`${url} is not JSON`);
  }
}

/**
 * Reads the file at this IPFS path (a CID, or <cid>/<file>) through the
 * gateway as bytes, with retries (see readThroughGateway).
 * @returns {Promise<Buffer>}
 */
export async function fetchIpfsBytes(path, options) {
  const { body } = await readThroughGateway(path, async (r) => Buffer.from(await r.arrayBuffer()), options);
  return body;
}
