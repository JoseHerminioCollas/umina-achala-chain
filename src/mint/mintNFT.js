/**
 * @file mintNFT.js
 * @description Mints an Umiña (a stone) or, with --token achala, an Achala (a
 * piece of jewelry made of Umiña NFTs) on Hedera (NETWORK, required), in this
 * order, so the ledger never holds a record for an NFT that does not exist:
 *
 * 1. check the environment and the metadata, plan the image versions
 *    (prepare.js); --dry-run stops here
 * 1b. make the image versions in generated/<stone_id>/; --images-only stops here
 * 2. read the provenance topic: refuse a stone_id already minted (--force
 *    skips this) and run the class's ledger checks (an Achala's stones)
 * 3. record COMPLIANCE in HCS; its transaction ID goes into the metadata
 * 4. pin the files, then the metadata, then mint (publish.js)
 * 5. record MINT in HCS
 *
 * Run from the command line, with NETWORK set (testnet or mainnet; it has no
 * default and the script refuses to run without it, see src/network.js):
 * NETWORK=testnet node src/mint/mintNFT.js <metadata-file | --form post-file> [--token umina|achala] [--out dir] [--force] [--dry-run | --images-only]
 *
 * What differs by token class is in umina.js and achala.js (`mintSteps`).
 * The full guide, with the input fields and every check, is
 * umina-achala-documents/scripts.md (mintNFT.js).
 */

import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";
import { writeVersions } from "./images.js";
import { readProvenance } from "../provenance.js";
import { buildMetadata, findMint, parseMintArgs } from "./lib.js";
import { prepareMint } from "./prepare.js";
import { pinAndMint } from "./publish.js";
import { mintSteps as uminaSteps } from "./umina.js";
import { mintSteps as achalaSteps } from "./achala.js";
import { TOKEN_CLASSES } from "../token/lib.js";
import { parseEcdsaKey } from "../keys.js";
import { fail, loadEnv, runScript } from "../script.js";

const input = parseMintArgs(process.argv.slice(2));
const { formFile, metadataFile, tokenClass, force, dryRun, imagesOnly } = input;
loadEnv();

const USAGE = `Mint an Umiña or an Achala: validate the metadata, pin the images and the
metadata to IPFS, record COMPLIANCE and MINT.

Usage: NETWORK=testnet node src/mint/mintNFT.js <metadata-file | --form post-file> [options]

  <metadata-file>        a metadata JSON file to mint
  --form <post-file>     a mint form post; the metadata file is generated from it
  --out <dir>            where the generated metadata and image versions go (default generated/)
  --token umina|achala   the token class (default umina)
  --force                mint even if the stone_id already has a MINT
  --dry-run              check everything and list the files it would make; makes
                         no image versions and sends nothing (--form still writes
                         the generated metadata file)
  --images-only          make the image versions and stop (no network)`;

// Exported so tests can wait for the run to finish (image work is real async work)
export const done = runScript("Unexpected error during minting workflow", async (session) => {
  if (input.problems.length) return fail(input.problems);
  if (!formFile && !metadataFile) {
    console.error(`❌ Give a form post or a metadata file.\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const steps = { umina: uminaSteps, achala: achalaSteps }[tokenClass];
  const { name: className, envVar: tokenVar } = TOKEN_CLASSES[tokenClass];
  const tokenId = process.env[tokenVar];

  // --- 1. Check the environment and the metadata, plan the image versions ---
  const prepared = await prepareMint(input, steps, process.env);
  const { metadata, images, documents } = prepared;
  if (prepared.generatedFile) console.log(`✅ Metadata file generated from ${formFile}: ${prepared.generatedFile}`);
  if (prepared.problems.length) return fail(prepared.problems);
  const stoneId = metadata.properties.stone_id;
  console.log(`✅ ${imagesOnly ? "Metadata" : "Environment and metadata"} for ${stoneId} are valid.`);

  const describeVersion = (v) => `${v.file} (${v.mime}, ${v.width}×${v.height})`;
  if (dryRun) {
    images.forEach((image) => Object.values(image.versions).forEach((v) => console.log(`Would make ${describeVersion(v)}`)));
    documents.forEach((d) => console.log(`Would pin ${d.file} (${d.mime})`));
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 1b. Make the image versions (master for every photo, display for the main one) ---
  for (const image of images) {
    image.versions = await writeVersions(image.file, image.info, image.versions);
    Object.values(image.versions).forEach((v) => console.log(`✅ Made ${describeVersion(v)}`));
  }
  const assets = [...images.flatMap((image) => Object.values(image.versions)), ...documents];

  if (imagesOnly) {
    assets.forEach((a) => console.log(`Would pin ${a.file} (${a.mime})`));
    console.log("Would pin this metadata (CIDs pending):");
    console.log(JSON.stringify(buildMetadata(steps.withAttributes(metadata), images, undefined, documents), null, 2));
    const show = (name) => process.env[name] || "not set";
    console.log(`Would record COMPLIANCE, mint under ${show(tokenVar)} and record MINT in ${show("HCS_TOPIC_ID")}.`);
    console.log("Images only: nothing pinned, minted or recorded.");
    return;
  }

  // --- 2. Check the HCS topic: it exists, the item is not minted yet, and the class's checks ---
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
  const earlier = findMint(events, stoneId);
  if (earlier && !force) {
    console.error(
      `❌ ${stoneId} is already minted (MINT event #${earlier.sequence_number}, serials ${earlier.event.serials}). Use --force to mint it again.`,
    );
    process.exitCode = 1;
    return;
  }
  if (earlier) console.log(`⚠️  ${stoneId} is already minted; minting again (--force).`);
  const ledger = await steps.checkLedger(metadata, events, process.env, tokenId);
  if (ledger.error) {
    console.error(`❌ ${ledger.error}`);
    process.exitCode = 1;
    return;
  }
  if (ledger.problems.length) return fail(ledger.problems);
  if (ledger.message) console.log(`✅ ${ledger.message}`);

  // --- 3. Record the compliance data in HCS before pinning ---
  // The metadata is immutable once pinned, so compliance_proof_hcs can only
  // point to a message that already exists: post it first (#14). If this
  // fails, nothing has been pinned or minted.
  const operatorId = process.env.OPERATOR_ID;
  const topicId = process.env.HCS_TOPIC_ID;
  const client = session.connect();
  try {
    const compliance = buildEvent(
      { event: "COMPLIANCE", stoneId, tokenId, serials: [], actorId: operatorId },
      steps.complianceFields(metadata.properties),
    );
    const complianceTxId = await submitEvent(client, topicId, compliance, loadSubmitKey(process.env));
    metadata.properties.compliance_proof_hcs = complianceTxId;
    metadata.properties.hcs_compliance_topic = topicId;
    console.log(`✅ COMPLIANCE recorded for ${stoneId}: ${complianceTxId}`);
  } catch (err) {
    console.error(`❌ Could not record COMPLIANCE for ${stoneId}; nothing was pinned or minted:`, err);
    process.exitCode = 1;
    return;
  }

  // --- 4. Pin the files, then the metadata, then mint ---
  // The attributes come from the data, not from the form
  let minted;
  try {
    minted = await pinAndMint(client, {
      stoneId,
      metadata: steps.withAttributes(metadata, ledger.context),
      images,
      documents,
      assets,
      tokenId,
      supplyKey: parseEcdsaKey(process.env.SUPPLY_KEY),
      jwt: process.env.PINATA_JWT,
    });
    console.log(`✅ Minted ${className} NFT serials: ${minted.serials} (${minted.mintTxId})`);
  } catch (err) {
    console.error(`❌ Nothing was minted for ${stoneId}:`, err);
    if (err.pinnedCids?.length) {
      const pins = err.pinnedCids.map((c) => `ipfs://${c}`).join(", ");
      console.error(`   These pins are not used by any NFT; unpin them in Pinata: ${pins}`);
    }
    process.exitCode = 1;
    return;
  }
  const { cid, ipfsUri, serials, mintTxId } = minted;

  // --- 5. Record MINT in HCS (the birth certificate) ---
  // The NFT exists now, so if this fails say so and keep what is needed to
  // notarize it by hand. submitEvent waits for the receipt, so a message
  // rejected at consensus lands here too.
  let hcsTxId;
  try {
    const message = buildEvent(
      { event: "MINT", stoneId, tokenId, serials, actorId: operatorId, ref: mintTxId },
      { ipfs_cid: cid, ...steps.mintFields(metadata) },
    );
    hcsTxId = await submitEvent(client, topicId, message, loadSubmitKey(process.env));
  } catch (err) {
    console.error(`❌ Minted serials ${serials} (${ipfsUri}) but the HCS notarization failed:`, err);
    const note = steps.mintFailureNote(metadata);
    if (note) console.error(`   ${note}`);
    process.exitCode = 1;
    return;
  }

  // --- 6. Provenance log ---
  console.table({
    stone_id: stoneId,
    event: "MINT",
    actor_id: operatorId,
    ipfs_cid: cid,
    hcs_tx_id: hcsTxId,
    timestamp: new Date().toISOString(),
  });
}, { usage: USAGE });
