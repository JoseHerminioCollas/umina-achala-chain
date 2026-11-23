/**
 * @file unpinBurned.js
 * @description Unpins from Pinata the IPFS files of burned NFTs that no
 * existing NFT uses: their metadata file, photos and documents.
 *
 * NETWORK=testnet node src/pinata/unpinBurned.js [--dry-run]
 *
 * It reads every NFT of the Umiña and Achala tokens from the mirror node,
 * burned ones included, and each one's metadata through the IPFS gateway. A
 * CID used by any NFT that still exists is kept. If the metadata of an
 * existing NFT cannot be read, it stops and unpins nothing, since that NFT's
 * files are not known. A burned NFT whose metadata cannot be read (already
 * unpinned) only has its metadata file's CID checked. Each CID is unpinned
 * with the key's unpin scope only; one the account does not pin is skipped.
 * --dry-run lists the CIDs and calls Pinata not at all. Nothing is
 * sent to Hedera. Gateway reads run 4 at a time, with a line per NFT, since the
 * public gateway takes seconds per file.
 */

import { envProblems } from "../env.js";
import { fetchIpfsJson } from "../ipfs.js";
import { tokenNfts } from "../mirror.js";
import { fail, loadEnv, parseScriptArgs, runScript } from "../script.js";
import { mapLimit, mirrorNftCid, nftCids, orphanCids, unpin } from "./lib.js";

const args = parseScriptArgs({ "dry-run": { type: "boolean" } }, 0);
const dryRun = Boolean(args.values["dry-run"]);
if (!args.problems.length) loadEnv();

const USAGE = `Unpin from Pinata the files of burned NFTs that no existing NFT uses.

Usage: NETWORK=testnet node src/pinata/unpinBurned.js [--dry-run]

Needs UMINA_TOKEN_ID, ACHALA_TOKEN_ID and PINATA_JWT (with the unpin scope).
--dry-run lists the CIDs and does not call Pinata. Nothing is sent to Hedera.`;

/** Gateway and Pinata reads running at once. */
const READS_AT_ONCE = 4;

const TOKENS = [
  ["Umiña", "UMINA_TOKEN_ID"],
  ["Achala", "ACHALA_TOKEN_ID"],
];

runScript("Unpin failed", async () => {
  if (args.problems.length) return fail(args.problems);
  const problems = envProblems(process.env, ["UMINA_TOKEN_ID", "ACHALA_TOKEN_ID", "PINATA_JWT"]);
  if (problems.length) return fail(problems);
  const jwt = process.env.PINATA_JWT;

  // --- 1. Every NFT and the CIDs it uses ---
  const mirror = [];
  for (const [name, envVar] of TOKENS) {
    for (const nft of await tokenNfts(process.env[envVar])) mirror.push({ name, nft });
  }
  console.log(`Reading the metadata of ${mirror.length} NFTs through the IPFS gateway (${READS_AT_ONCE} at a time)...`);
  const unreadable = [];
  let done = 0;
  const nfts = await mapLimit(mirror, READS_AT_ONCE, async ({ name, nft }) => {
    const label = `${name} #${nft.serial_number}`;
    const deleted = Boolean(nft.deleted);
    const cid = mirrorNftCid(nft);
    let metadata = null;
    let note = "";
    if (cid) {
      try {
        // A burned NFT's metadata may be unpinned already: fewer tries.
        metadata = await fetchIpfsJson(cid, deleted ? { tries: 2, timeoutMs: 15000 } : undefined);
      } catch (err) {
        if (!deleted) unreadable.push(`${label}: ${err.message}`);
        note = deleted ? `, metadata not readable, checking only ${cid}` : ", NOT READABLE";
      }
    } else if (!deleted) {
      unreadable.push(`${label}: its on-chain metadata is not an ipfs:// URI`);
      note = ", no ipfs:// URI";
    }
    console.log(`  [${++done}/${mirror.length}] ${label}${deleted ? " (burned)" : ""}${note}`);
    return { label, deleted, cids: nftCids(cid, metadata) };
  });
  if (unreadable.length) return fail(unreadable, "Cannot read the files of existing NFTs; nothing unpinned");

  // --- 2. The CIDs only burned NFTs use ---
  const orphans = orphanCids(nfts);
  const burned = nfts.filter((n) => n.deleted).length;
  console.log(`${nfts.length} NFTs, ${burned} burned; ${orphans.length} CIDs used only by burned NFTs:`);
  for (const { cid, nfts: labels } of orphans) console.log(`  ${cid}  (${labels.join(", ")})`);
  if (!orphans.length) return;

  if (dryRun) {
    console.log("Dry run, nothing unpinned.");
    return;
  }

  // --- 3. Unpin, one at a time; a CID the account does not pin is skipped ---
  let unpinned = 0;
  for (const [i, { cid }] of orphans.entries()) {
    const result = await unpin(cid, jwt);
    if (result === "unpinned") unpinned++;
    console.log(`  [${i + 1}/${orphans.length}] ${result === "unpinned" ? "✅ unpinned" : "already not pinned"} ${cid}`);
  }
  console.log(`✅ ${unpinned} CIDs unpinned, ${orphans.length - unpinned} were not pinned.`);
}, { usage: USAGE });
