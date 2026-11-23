/**
 * @file catalog/buildCatalog.js
 * @description Builds the site's catalog, catalog.json, from the chain and
 * IPFS (umina-achala-chain#44): the cache the site reads (Layer 3 in #10). Run
 * by hand after a mint, a listing change or a sale, then publish the file
 * (umina-achala-web#89). It only reads: it sends nothing to Hedera and needs
 * no keys.
 *
 * NETWORK=testnet node src/catalog/buildCatalog.js <out-dir> [--dry-run]
 *
 * It holds only what UA has for sale (Phase 2B: the Treasury): see
 * catalog/lib.js for the rule. Each item has its HIP-412 metadata, checked
 * against its schema, its price from LISTED and its provenance events; an
 * Achala also has its mounted stones.
 *
 * Metadata is read through the IPFS gateway (IPFS_GATEWAY, or UA's default),
 * except a CID already in the previous catalog.json in <out-dir>: IPFS files
 * never change. If the mirror node or the gateway fails, the build stops and
 * the old catalog stays. An item whose metadata is not valid is left out,
 * with a warning.
 *
 * Each photo (an NFT's image and its image files) gets a thumbnail and a
 * display copy under <out-dir>/media/ (umina-achala-chain#45; catalog/media.js),
 * read through the gateway once: a copy already on disk is not read again.
 * A photo that cannot be read is left without a copy, with a warning; the
 * site then loads it through the gateway.
 *
 * Each 3D model and PDF document is copied there too, unchanged
 * (umina-achala-chain#46), the same way: once, and a file that cannot be read
 * gets no copy, with a warning. The build ends with the size of media/.
 *
 * The file is written to catalog.json.tmp, then renamed, so a build that
 * fails half way never leaves a broken catalog. --dry-run prints what would
 * be in it and writes nothing (no photo, model or document is read).
 */

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { latestArrival, tokenNfts } from "../mirror.js";
import { cidOfNftMetadata, fetchIpfsJson, ipfsGateway, NotJsonError } from "../ipfs.js";
import { mirrorNode, networkName } from "../network.js";
import { readDisplay, readProvenance } from "../provenance.js";
import { mintOfSerial } from "../mint/achala.js";
import { validateMetadata } from "../mint/metadataValidator.js";
import { MEDIA_DIR, ensureFile, ensureMedia, fileUris, folderSize, photoUris } from "./media.js";
import {
  CATALOG_FILE,
  KINDS,
  achalaStonesProblem,
  catalogDocument,
  catalogEnvProblems,
  catalogItem,
  catalogNft,
  catalogProblems,
  isoSeconds,
  itemEvents,
  lastSeq,
  listingSince,
  metadataCache,
  sortNfts,
} from "./lib.js";
import { fail, loadEnv, parseScriptArgs, runScript } from "../script.js";

const USAGE = `Build the site's catalog (catalog.json) from the chain and IPFS: only what UA
has for sale, with its metadata, price and provenance events. It only reads;
nothing is sent to Hedera.

Usage:
  NETWORK=testnet node src/catalog/buildCatalog.js <out-dir> [--dry-run]

  <out-dir>    where catalog.json and media/ (copies of the photos, 3D models
               and documents) are written,
               e.g. ../umina-achala-web/frontend/public/data
  IPFS_GATEWAY the gateway to read metadata and files through (optional, in the env file)`;

const args = parseScriptArgs({ "dry-run": { type: "boolean" } }, 1);
loadEnv();

/** Reads the previous catalog in outDir, or null when there is none or it is not JSON. */
async function readPrevious(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.log(`⚠️  ${path} is not JSON; all metadata is read again.`);
    return null;
  }
}

/**
 * Reads one NFT's metadata (the cache first, then the gateway) and checks it
 * against its class's schema. Returns { metadata } or { problem }; a gateway
 * failure throws, which stops the build.
 */
async function loadMetadata(cid, kind, cache, counts) {
  if (!cid) return { problem: "its on-chain metadata is not an ipfs:// URI" };
  let metadata = cache.get(cid);
  if (metadata) {
    counts.cached++;
  } else {
    try {
      metadata = await fetchIpfsJson(cid);
    } catch (err) {
      if (err instanceof NotJsonError) return { problem: `its metadata ${cid} is not JSON` };
      throw err;
    }
    cache.set(cid, metadata);
    counts.fetched++;
  }
  const { valid, errors } = validateMetadata(metadata, kind);
  if (!valid) {
    const first = errors.slice(0, 3).map((e) => `${e.instancePath ?? ""} ${e.message}`.trim());
    return { problem: `its metadata ${cid} is not valid: ${first.join("; ")}` };
  }
  return { metadata };
}

/** The mounted stones of an Achala for the catalog, or { problem }. */
async function achalaStones(env, metadata, nfts, provenance, cache, counts) {
  const problem = achalaStonesProblem(metadata, nfts.umina, env.TREASURY_ID);
  if (problem) return { problem };
  const stones = [];
  for (const { serial } of metadata.properties.stones) {
    const tokenId = env.UMINA_TOKEN_ID;
    const mint = mintOfSerial(provenance, tokenId, serial);
    if (!mint) return { problem: `its stone serial ${serial} has no MINT on the provenance topic` };
    const nft = nfts.umina.find((n) => n.serial_number === Number(serial));
    const cid = cidOfNftMetadata(nft.metadata);
    const loaded = await loadMetadata(cid, "umina", cache, counts);
    if (loaded.problem) return { problem: `stone ${mint.event.stone_id}: ${loaded.problem}` };
    stones.push(
      catalogNft({
        stone_id: mint.event.stone_id,
        token_id: tokenId,
        serial: Number(serial),
        cid,
        metadata: loaded.metadata,
        events: itemEvents(provenance, tokenId, serial, mint),
      }),
    );
  }
  return { stones };
}

runScript("Catalog build failed", async () => {
  // --- 1. Check the arguments and the environment ---
  const env = process.env;
  const [outDir] = args.positionals;
  const problems = [...args.problems];
  if (!problems.length && !outDir) problems.push("give the folder to write catalog.json to (see --help)");
  if (!problems.length) problems.push(...catalogEnvProblems(env));
  if (problems.length) return fail(problems);
  const path = join(outDir, CATALOG_FILE);
  const network = networkName();

  // --- 2. Read both topics and every NFT of both tokens ---
  const [provenance, display, uminaNfts, achalaNfts] = await Promise.all([
    readProvenance(env),
    readDisplay(env),
    tokenNfts(env.UMINA_TOKEN_ID),
    tokenNfts(env.ACHALA_TOKEN_ID),
  ]);
  if (provenance.problem) return fail([provenance.problem]);
  if (display.problem) return fail([display.problem]);
  const nfts = { umina: uminaNfts, achala: achalaNfts };

  // --- 3. Which NFTs may be for sale ---
  const { candidates, leftOut } = sortNfts({ env, nfts, provenance: provenance.events, display: display.events });
  const cache = metadataCache(await readPrevious(path), network);
  const counts = { fetched: 0, cached: 0 };

  // --- 4. Each candidate: listed since it last arrived, metadata, an Achala's stones ---
  const items = [];
  const warnings = [];
  for (const candidate of candidates) {
    const { kind, token_id: tokenId, serial, stone_id: stoneId, cid, mint } = candidate;
    const out = (reason) => leftOut.push({ kind, token_id: tokenId, serial, stone_id: stoneId, reason });
    const since = await latestArrival(tokenId, serial, env.TREASURY_ID);
    const price = listingSince(display.events, tokenId, serial, since);
    if (!price) {
      out("not listed since it last arrived in the Treasury");
      continue;
    }
    const loaded = await loadMetadata(cid, kind, cache, counts);
    if (loaded.problem) {
      warnings.push(`${stoneId} (${tokenId}/${serial}) is left out: ${loaded.problem}`);
      out(loaded.problem);
      continue;
    }
    let stones;
    if (kind === "achala") {
      const mounted = await achalaStones(env, loaded.metadata, nfts, provenance.events, cache, counts);
      if (mounted.problem) {
        warnings.push(`${stoneId} (${tokenId}/${serial}) is left out: ${mounted.problem}`);
        out(mounted.problem);
        continue;
      }
      stones = mounted.stones;
    }
    const events = itemEvents(provenance.events, tokenId, serial, mint);
    items.push(catalogItem({ stone_id: stoneId, token_id: tokenId, serial, cid, metadata: loaded.metadata, events }, { kind, price, stones }));
  }

  // --- 5. Photos: a thumbnail and a display copy of each, once (#45) ---
  const dryRun = args.values["dry-run"];
  const media = {};
  const photos = { read: 0, onDisk: 0 };
  for (const uri of photoUris(items)) {
    try {
      const { paths, read } = await ensureMedia(outDir, uri, { dryRun });
      media[uri] = paths;
      photos[read ? "read" : "onDisk"]++;
    } catch (err) {
      warnings.push(`photo ${uri} has no copy (the site loads it through the gateway): ${err.message}`);
    }
  }

  // --- 5b. 3D models and documents: a copy of each, unchanged, once (#46) ---
  const files = { read: 0, onDisk: 0 };
  for (const { uri, type } of fileUris(items)) {
    try {
      const { paths, read } = await ensureFile(outDir, uri, type, { dryRun });
      media[uri] = paths;
      files[read ? "read" : "onDisk"]++;
    } catch (err) {
      warnings.push(`file ${uri} (${type}) has no copy (the site loads it through the gateway): ${err.message}`);
    }
  }

  // --- 6. The catalog, checked against its schema ---
  const catalog = catalogDocument({
    network,
    builtAt: isoSeconds(new Date()),
    source: {
      mirror: mirrorNode(),
      ipfs_gateway: ipfsGateway(),
      umina_token_id: env.UMINA_TOKEN_ID,
      achala_token_id: env.ACHALA_TOKEN_ID,
      provenance_topic: env.HCS_TOPIC_ID,
      display_topic: env.HCS_DISPLAY_TOPIC_ID,
      treasury_id: env.TREASURY_ID,
      provenance_seq: lastSeq(provenance.events),
      display_seq: lastSeq(display.events),
    },
    items,
    media,
  });
  const invalid = catalogProblems(catalog);
  if (invalid.length) return fail(invalid, "The catalog does not match schema/catalog-schema.json (nothing written)");

  // --- 7. Print it ---
  if (catalog.items.length) {
    console.log("For sale:");
    console.table(
      catalog.items.map((i) => ({
        kind: i.kind,
        serial: i.serial,
        stone_id: i.stone_id,
        price: `${i.price.amount} ${i.price.currency}`,
        ...(i.stones && { stones: i.stones.map((s) => s.stone_id).join(", ") }),
      })),
    );
  } else {
    console.log("Nothing is for sale: the catalog has no items.");
  }
  if (leftOut.length) {
    console.log("Left out:");
    console.table(
      leftOut
        .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.serial - b.serial).map(({ kind, serial, stone_id, reason }) => ({ kind, serial, stone_id: stone_id ?? "-", reason })),
    );
  }
  warnings.forEach((w) => console.log(`⚠️  ${w}`));
  console.log(`Metadata: ${counts.fetched} read through the gateway, ${counts.cached} from the previous catalog.`);
  console.log(
    dryRun
      ? `Photos: ${photos.read} would be read through the gateway, ${photos.onDisk} already in ${outDir}/media.`
      : `Photos: ${photos.read} read through the gateway and copied, ${photos.onDisk} already in ${outDir}/media.`,
  );
  console.log(
    dryRun
      ? `Models and documents: ${files.read} would be read through the gateway, ${files.onDisk} already in ${outDir}/media.`
      : `Models and documents: ${files.read} read through the gateway and copied, ${files.onDisk} already in ${outDir}/media.`,
  );
  const mb = ((await folderSize(join(outDir, MEDIA_DIR))) / 1e6).toFixed(1);
  console.log(`${outDir}/media holds ${mb} MB${dryRun ? " now" : ""}.`);

  // --- 8. Write it: a temp file, then rename ---
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  if (dryRun) {
    console.log(`Dry run: would write ${catalog.items.length} items (${json.length} bytes) to ${path}. Nothing written.`);
    return;
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(`${path}.tmp`, json);
  await rename(`${path}.tmp`, path);
  console.log(`✅ Wrote ${catalog.items.length} items to ${path}.`);
}, { usage: USAGE });
