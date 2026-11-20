/**
 * @file catalog/lib.js
 * @description The catalog builder's rules, with no network calls
 * (umina-achala-chain#44): which NFTs are for sale, the events kept for each
 * item, and the shape of catalog.json (schema/catalog-schema.json).
 *
 * Phase 2B: only the Treasury sells. An NFT is in the catalog when it is not
 * burned, the Treasury holds it, it has a MINT, it is not an Umiña mounted in
 * an Achala that still exists (it is sold with its Achala), and its latest
 * display event since it last arrived in the Treasury is LISTED. An Achala is
 * in only when the Treasury still holds each of its stones.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../schema/catalog-schema.json" with { type: "json" };
import { envProblems } from "../env.js";
import { cidOfNftMetadata } from "../ipfs.js";
import { currentListing } from "../display/lib.js";
import { mintOfSerial, mountedStones } from "../mint/achala.js";

export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_FILE = "catalog.json";

/** What the builder needs from the env file. No keys: it only reads. */
export const CATALOG_ENV = ["UMINA_TOKEN_ID", "ACHALA_TOKEN_ID", "HCS_TOPIC_ID", "HCS_DISPLAY_TOPIC_ID", "TREASURY_ID"];

/** The token classes, in the catalog's order. */
export const KINDS = ["umina", "achala"];

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

/** The problems with the environment, in CATALOG_ENV order. */
export function catalogEnvProblems(env) {
  return envProblems(env, CATALOG_ENV);
}

/** The token ID of a kind, from the environment. */
export function tokenIdOf(env, kind) {
  return kind === "umina" ? env.UMINA_TOKEN_ID : env.ACHALA_TOKEN_ID;
}

const bySerial = (a, b) => a.serial_number - b.serial_number;
const includesSerial = (serials, serial) => (serials ?? []).map(String).includes(String(serial));

/**
 * Sorts every NFT of both tokens, burned ones skipped, into candidates (they
 * may be listed) and the ones left out, each with its reason. Whether a
 * candidate's listing counts depends on when it last arrived in the Treasury,
 * which is checked afterwards (listingSince). A listing that counts since then
 * is also the latest overall, so an NFT not listed overall is left out here.
 * @param {{ env: object, nfts: { umina: object[], achala: object[] }, provenance: object[], display: object[] }} input
 * @returns {{ candidates: object[], leftOut: object[] }}
 */
export function sortNfts({ env, nfts, provenance, display }) {
  const mounted = mountedStones(provenance, env.ACHALA_TOKEN_ID);
  const candidates = [];
  const leftOut = [];
  for (const kind of KINDS) {
    const tokenId = tokenIdOf(env, kind);
    for (const nft of [...(nfts[kind] ?? [])].sort(bySerial)) {
      if (nft.deleted) continue;
      const serial = nft.serial_number;
      const mint = mintOfSerial(provenance, tokenId, serial);
      const row = { kind, token_id: tokenId, serial, stone_id: mint?.event.stone_id ?? null };
      const out = (reason) => leftOut.push({ ...row, reason });
      if (nft.account_id !== env.TREASURY_ID) {
        out(`held by ${nft.account_id}`);
      } else if (!mint) {
        out("no MINT on the provenance topic");
      } else if (kind === "umina" && mounted.has(mint.event.stone_id)) {
        out(`mounted in ${mounted.get(mint.event.stone_id).event.stone_id}, sold with it`);
      } else if (!currentListing(display, tokenId, serial, null).listed) {
        out("not listed");
      } else {
        candidates.push({ ...row, cid: cidOfNftMetadata(nft.metadata), mint });
      }
    }
  }
  return { candidates, leftOut };
}

/**
 * The listing of a candidate, counting only display events since it last
 * arrived in the Treasury (`since`), as displayEvent.js does (#43): an item
 * sold and returned is listed again by hand. Adds the price as the catalog
 * holds it, or null when it is not listed.
 * @returns {{ amount: string, currency: string, listed_seq: number, listed_at: string } | null}
 */
export function listingSince(display, tokenId, serial, since) {
  const listing = currentListing(display, tokenId, serial, since);
  if (!listing.listed) return null;
  const entry = display.find((e) => e.sequence_number === listing.sequence_number);
  return {
    amount: listing.price,
    currency: entry.event.currency,
    listed_seq: listing.sequence_number,
    listed_at: entry.consensus_timestamp,
  };
}

/**
 * The provenance events of one NFT, in topic order: those naming its token and
 * serial; an Achala's events naming it as a mounted stone, by serial
 * (umina_serials) or by stone_id (from_stone_ids: the Achala's MINT), the
 * latter only between its MINT and the next MINT of the same stone_id (minted
 * again with --force); and the COMPLIANCE recorded just before its MINT (it
 * has no serial yet).
 * @param {object[]} provenance
 * @param {string} tokenId
 * @param {number} serial
 * @param {{ sequence_number: number, event: object }} mint its MINT entry
 */
export function itemEvents(provenance, tokenId, serial, mint) {
  const compliance = provenance
    .filter(
      ({ event, sequence_number }) =>
        event.event === "COMPLIANCE" &&
        event.stone_id === mint.event.stone_id &&
        sequence_number < mint.sequence_number,
    )
    .at(-1);
  const stoneId = mint.event.stone_id;
  const nextMint = provenance.find(
    ({ event, sequence_number }) =>
      event.event === "MINT" && event.stone_id === stoneId && sequence_number > mint.sequence_number,
  );
  const whileThisSerial = (seq) => seq > mint.sequence_number && (!nextMint || seq < nextMint.sequence_number);
  return provenance
    .filter(
      (entry) =>
        entry === compliance ||
        (entry.event.token_id === String(tokenId) && includesSerial(entry.event.serials, serial)) ||
        (entry.event.umina_token_id === String(tokenId) && includesSerial(entry.event.umina_serials, serial)) ||
        ((entry.event.from_stone_ids ?? []).includes(stoneId) && whileThisSerial(entry.sequence_number)),
    )
    .map(({ sequence_number, consensus_timestamp, event }) => ({
      seq: sequence_number,
      consensus_timestamp: consensus_timestamp ?? null,
      event,
    }));
}

/**
 * The problem with an Achala's mounted stones, from its metadata
 * (properties.stones), or null: each must exist, not be burned, and be held by
 * the Treasury, or the Achala cannot be sold.
 * @param {object} metadata the Achala's HIP-412 metadata
 * @param {object[]} uminaNfts every Umiña NFT (mirror node)
 * @param {string} treasuryId
 */
export function achalaStonesProblem(metadata, uminaNfts, treasuryId) {
  for (const { serial, stone_id: stoneId } of metadata?.properties?.stones ?? []) {
    const nft = uminaNfts.find((n) => n.serial_number === Number(serial));
    if (!nft || nft.deleted) return `its stone ${stoneId} (serial ${serial}) is burned or missing`;
    if (nft.account_id !== treasuryId) return `its stone ${stoneId} (serial ${serial}) is held by ${nft.account_id}`;
  }
  return null;
}

/**
 * The metadata already read, by CID, from the previous catalog: IPFS files
 * never change, so they are not read again. Empty when there is no usable
 * previous catalog or it is from another network.
 * @param {object | null} previous the previous catalog.json, parsed
 * @param {string} network
 * @returns {Map<string, object>}
 */
export function metadataCache(previous, network) {
  const cache = new Map();
  if (previous?.schema_version !== CATALOG_SCHEMA_VERSION || previous.network !== network) return cache;
  for (const item of previous.items ?? []) {
    for (const nft of [item, ...(item.stones ?? [])]) {
      if (nft?.metadata_cid && nft.metadata && typeof nft.metadata === "object") cache.set(nft.metadata_cid, nft.metadata);
    }
  }
  return cache;
}

/** One NFT as the catalog holds it; an item adds kind, price and, for an Achala, its stones. */
export function catalogNft({ stone_id, token_id, serial, cid, metadata, events }) {
  return { stone_id, token_id, serial, metadata_cid: cid, metadata, events };
}

/** One item for sale. */
export function catalogItem(nft, { kind, price, stones }) {
  return { kind, ...catalogNft(nft), price, ...(kind === "achala" && { stones }) };
}

/** The last sequence number read from a topic, 0 when it is empty. */
export function lastSeq(events) {
  return events.at(-1)?.sequence_number ?? 0;
}

/**
 * The whole catalog, items sorted by kind (umina, then achala) and serial,
 * media by URI, keys in a fixed order: two builds with no change on the chain
 * differ only in built_at.
 * @param {{ network: string, builtAt: string, source: object, items: object[], media?: object }} input
 *   media: each photo's ipfs:// URI → its copies' paths (umina-achala-chain#45)
 */
export function catalogDocument({ network, builtAt, source, items, media = {} }) {
  const sorted = [...items].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.serial - b.serial);
  const mediaSorted = Object.fromEntries(Object.entries(media).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { schema_version: CATALOG_SCHEMA_VERSION, network, built_at: builtAt, source, items: sorted, media: mediaSorted };
}

/** The problems with a catalog against schema/catalog-schema.json; empty when valid. */
export function catalogProblems(catalog) {
  if (validateSchema(catalog)) return [];
  return validateSchema.errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
}

/** A time as the catalog writes it: ISO 8601 to the second, UTC. */
export function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
