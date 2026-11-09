/**
 * @file mintNFT.js
 * @description Mints an NFT on Hedera (NETWORK, testnet by default), an Umiña
 * (a stone, the default) or, with --token achala, an Achala (a piece of jewelry
 * made of one or more Umiña NFTs, umina-achala-chain#16): validates the HIP-412
 * metadata against the class's schema, pins its image and files to IPFS through
 * Pinata, pins the metadata itself, mints under the class's token, then
 * notarizes the mint in HCS (pin, mint, notarize, so the ledger never holds a
 * MINT record for an NFT that does not exist).
 *
 * The metadata file has no `image` or `files` of its own. Instead it names the
 * item's photos in input-only fields, `main_image` (required) and `images`
 * (up to 5 more), and optionally its receipts and permits in `documents`. Each
 * entry has a `file` (a path relative to the metadata file) and a
 * `description`. Each photo is checked (JPEG, PNG or WebP by its real type, up
 * to 25 MB and about 100 megapixels) and re-encoded without EXIF into
 * generated/<stone_id>/ (#7): a master for every photo, and a 1080 px display
 * version of the main photo. Those files are pinned first; then `image` (the
 * display version) and one `files[]` entry per master (the main one is the
 * default file, each with its SHA-256 checksum) and per document are set from
 * their CIDs, the input fields are dropped, and the result is pinned.
 *
 * --images-only makes the image files and prints what would be pinned
 * (including the metadata) and minted, without pinning, minting or needing
 * any credentials. --dry-run only lists the files it would make.
 *
 * Run from the command line:
 * node src/mint/mintNFT.js [metadata-file | --form post-file] [--token umina|achala] [--out dir] [--force] [--dry-run | --images-only]
 *
 * With --form the input is a simulated mint form post (see formPost.js). The
 * metadata file is generated from it, starting from the class's template
 * (json/umina-template.json or json/achala-template.json), into --out (default
 * generated/) and then minted. Otherwise give the path of a metadata file.
 * One of the two is required. properties.stone_id must follow
 * UMINA-YYYY-XX-NN for an Umiña and ACHALA-YYYY-XX-NN for an Achala.
 * Variables come from the network's env file (.env.testnet by default, see src/network.js). --dry-run checks the environment and the
 * metadata and sends nothing, but still writes the generated metadata file.
 *
 * Before pinning, a real run reads the HCS topic from the mirror node and
 * refuses a stone_id that already has a MINT event, or a topic that does not
 * exist (the mint would have nowhere to be recorded). --force skips the
 * duplicate check, not the topic check. For an Achala it also checks each of
 * properties.stones (achala.js): in the Umiña token, matching its MINT event,
 * not burned, held by the treasury and not mounted in another Achala; --force
 * does not skip these. Then a COMPLIANCE event is posted (an Umiña: stone
 * type, RUC, concession, REINFO, HS code; an Achala: piece type, artisan,
 * RUC, HS code, stones), and its transaction ID becomes
 * properties.compliance_proof_hcs in the pinned metadata. The attributes
 * wallets show are written from the data (an Umiña: Stone Type, Materials,
 * Form from schema/stone-types.json; an Achala: Piece Type, Metal, Stones,
 * Artisan). If the run fails after pinning, the CIDs pinned so far are
 * printed so they can be unpinned in Pinata.
 *
 * An Achala's MINT event lists its stones (from_stone_ids): that records
 * them as mounted. The stones get no events of their own; the Achala's BURN,
 * when the piece is taken apart, unmounts them.
 *
 * ## Output
 * - IPFS CID of pinned metadata
 * - Minted NFT serial number(s)
 * - Provenance log (stone_id, event, actor_id, ipfs_cid, hcs_tx_id, timestamp)
 */

import { TokenMintTransaction } from "@hashgraph/sdk";
import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";
import fs from "fs";
import { validateMetadata } from "./metadataValidator.js";
import { inspectImage, planVersions, writeVersions } from "./images.js";
import path from "path";
import { nftInfo, topicEvents } from "../mirror.js";
import {
  buildMetadata,
  checkStoneId,
  collectDocuments,
  collectImages,
  findMint,
  MINT_CLASSES,
  missingAssets,
  parseMintArgs,
  pinFile,
  pinJson,
  samplesFolderProblem,
  validateMintEnv,
} from "./lib.js";
import { metadataFromForm, writeGeneratedMetadata } from "./formPost.js";
import { withStoneTypeAttributes } from "./stoneTypes.js";
import {
  achalaComplianceFields,
  stoneLedgerProblems,
  stoneTypesFromEvents,
  uminaTokenProblem,
  withAchalaAttributes,
  withUminaTokenId,
} from "./achala.js";
import { TOKEN_CLASSES } from "../token/lib.js";
import { parseEcdsaKey } from "../keys.js";
import { fail, loadEnv, runScript } from "../script.js";

const input = parseMintArgs(process.argv.slice(2));
const { formFile, outDir, tokenClass, force, dryRun, imagesOnly } = input;
let metadataFile = input.metadataFile;
const isAchala = tokenClass === "achala";
loadEnv();


/**
 * An Achala's metadata with properties.umina_token_id set from
 * UMINA_TOKEN_ID when it is absent; other metadata unchanged.
 */
function withStonesToken(metadata) {
  return isAchala && process.env.UMINA_TOKEN_ID ? withUminaTokenId(metadata, process.env.UMINA_TOKEN_ID) : metadata;
}

/** The attributes wallets show, written from the data of the class. */
function withGeneratedAttributes(metadata, stoneTypeById) {
  return isAchala ? withAchalaAttributes(metadata, stoneTypeById) : withStoneTypeAttributes(metadata);
}

// Exported so tests can wait for the run to finish (image work is real async work)
export const done = runScript("Unexpected error during minting workflow", async (session) => {
  if (input.problems.length) return fail(input.problems);
  if (!formFile && !metadataFile) {
    console.error(
      "❌ Give a form post or a metadata file:\n" +
        "   node src/mint/mintNFT.js --form json/sample-umina-form-post.json [--token umina|achala] [--out dir] [--force] [--dry-run | --images-only]\n" +
        "   node src/mint/mintNFT.js <metadata-file> [--token umina|achala] [--out dir] [--force] [--dry-run | --images-only]",
    );
    process.exitCode = 1;
    return;
  }
  const { name: className, envVar: tokenVar } = TOKEN_CLASSES[tokenClass];
  const tokenId = process.env[tokenVar];

  // --- 1. Check the environment and the metadata ---
  // --images-only never leaves the machine, so it needs no credentials
  const problems = imagesOnly ? [] : validateMintEnv(process.env, tokenClass);
  if (formFile) {
    // Simulated form post: generate the metadata file from it first
    const form = JSON.parse(fs.readFileSync(formFile, "utf8"));
    const template = JSON.parse(fs.readFileSync(MINT_CLASSES[tokenClass].template, "utf8"));
    const generated = metadataFromForm(form, template, path.dirname(path.resolve(formFile)));
    metadataFile = writeGeneratedMetadata(withStonesToken(generated), outDir);
    console.log(`✅ Metadata file generated from ${formFile}: ${metadataFile}`);
  }
  const metadata = withStonesToken(JSON.parse(fs.readFileSync(metadataFile, "utf8")));
  if (isAchala) {
    // The stones are named by stone_id and serial, all in the Umiña token
    if (!process.env.UMINA_TOKEN_ID) {
      if (imagesOnly) problems.push("UMINA_TOKEN_ID is missing; it fills properties.umina_token_id");
    } else {
      const tokenProblem = uminaTokenProblem(metadata.properties ?? {}, process.env.UMINA_TOKEN_ID);
      if (tokenProblem) problems.push(tokenProblem);
    }
  }
  const baseDir = path.dirname(path.resolve(metadataFile));
  const { images, problems: imageProblems } = collectImages(metadata, baseDir);
  problems.push(...imageProblems);
  const { documents, problems: documentProblems } = collectDocuments(metadata, baseDir);
  problems.push(...documentProblems);
  const uploads = [...images, ...documents];
  const samplesProblem = samplesFolderProblem(uploads, path.resolve("samples"));
  if (samplesProblem) problems.push(samplesProblem);
  else missingAssets(uploads).forEach((a) => problems.push(`file not found: ${a.file}`));
  const idProblem = checkStoneId(metadata.properties?.stone_id, tokenClass);
  if (idProblem) problems.push(idProblem);

  // Check each photo from its header (type, size, pixels) and plan its
  // versions in generated/<stone_id>/ (#7); nothing is written yet
  if (!problems.length) {
    const stoneDir = path.join(outDir, metadata.properties.stone_id);
    for (const image of images) {
      const info = await inspectImage(image.file, image.label);
      if (info.problem) problems.push(info.problem);
      else Object.assign(image, { info, versions: planVersions(image, info, stoneDir) });
    }
  }
  if (!problems.length) {
    // The files have no CIDs yet, so check the schema with placeholder URIs
    const { valid, errors } = validateMetadata(
      buildMetadata(metadata, images, undefined, documents),
      tokenClass,
    );
    if (!valid) {
      errors.forEach((e) =>
        problems.push(`${metadataFile} failed validation: ${e.instancePath || "/"} ${e.message}`),
      );
    }
  }
  if (problems.length) return fail(problems);
  const stoneId = metadata.properties.stone_id;
  console.log(`✅ ${imagesOnly ? "Metadata" : "Environment and metadata"} for ${stoneId} are valid.`);

  const describeVersion = (v) => `${v.file} (${v.mime}, ${v.width}×${v.height})`;
  if (dryRun) {
    for (const image of images) {
      Object.values(image.versions).forEach((v) => console.log(`Would make ${describeVersion(v)}`));
    }
    documents.forEach((d) => console.log(`Would pin ${d.file} (${d.mime})`));
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 1b. Make the image versions (master for every photo, display for the main one) ---
  for (const image of images) {
    image.versions = await writeVersions(image.file, image.info, image.versions);
    Object.values(image.versions).forEach((v) => console.log(`✅ Made ${describeVersion(v)}`));
  }
  const assets = [
    ...images.flatMap((image) => Object.values(image.versions)),
    ...documents,
  ];

  if (imagesOnly) {
    assets.forEach((a) => console.log(`Would pin ${a.file} (${a.mime})`));
    const preview = buildMetadata(withGeneratedAttributes(metadata), images, undefined, documents);
    console.log("Would pin this metadata (CIDs pending):");
    console.log(JSON.stringify(preview, null, 2));
    const show = (name) => process.env[name] || "not set";
    console.log(
      `Would record COMPLIANCE, mint under ${show(tokenVar)} and record MINT in ${show("HCS_TOPIC_ID")}.`,
    );
    console.log("Images only: nothing pinned, minted or recorded.");
    return;
  }

  // --- 2. Check the HCS topic: it exists, and the item is not minted yet ---
  let events;
  try {
    events = await topicEvents(process.env.HCS_TOPIC_ID);
  } catch (err) {
    console.error(`❌ Cannot read HCS_TOPIC_ID ${process.env.HCS_TOPIC_ID}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const earlier = findMint(events, stoneId);
  if (earlier && !force) {
    console.error(
      `❌ ${stoneId} is already minted (MINT event #${earlier.sequence_number}, serials ${earlier.event.serials}). Use --force to mint it again.`,
    );
    process.exitCode = 1;
    return;
  }
  if (earlier) console.log(`⚠️  ${stoneId} is already minted; minting again (--force).`);

  // --- 2b. An Achala: check each of its Umiña stones on the ledger ---
  const stones = isAchala ? metadata.properties.stones : [];
  let stoneTypeById;
  if (isAchala) {
    const nfts = [];
    try {
      for (const s of stones) nfts.push(await nftInfo(process.env.UMINA_TOKEN_ID, s.serial));
    } catch (err) {
      console.error(`❌ Cannot check the stones on the mirror node: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const stoneProblems = stoneLedgerProblems(stones, nfts, events, {
      uminaTokenId: process.env.UMINA_TOKEN_ID,
      achalaTokenId: tokenId,
      treasuryId: process.env.TREASURY_ID,
    });
    if (stoneProblems.length) return fail(stoneProblems);
    stoneTypeById = stoneTypesFromEvents(events, stones);
    console.log(`✅ Stones checked: ${stones.map((s) => s.stone_id).join(", ")}`);
  }

  // --- 3. Connect to Hedera ---
  const operatorId = process.env.OPERATOR_ID;
  const supplyKey = parseEcdsaKey(process.env.SUPPLY_KEY);
  const client = session.connect();

  // --- 3b. Record the compliance data in HCS before pinning ---
  // The metadata is immutable once pinned, so compliance_proof_hcs can only
  // point to a message that already exists: post it first (#14). If this
  // fails, nothing has been pinned or minted.
  try {
    const { properties } = metadata;
    const fields = isAchala
      ? achalaComplianceFields(properties)
      : {
          stone_type: properties.stone_type,
          vendor_ruc: properties.vendor_ruc,
          mining_concession: properties.mining_concession,
          reinfo_id: properties.reinfo_id,
          hs_code: properties.hs_code,
        };
    const compliance = buildEvent(
      { event: "COMPLIANCE", stoneId, tokenId, serials: [], actorId: operatorId },
      fields,
    );
    const complianceTxId = await submitEvent(
      client,
      process.env.HCS_TOPIC_ID,
      compliance,
      loadSubmitKey(process.env),
    );
    metadata.properties.compliance_proof_hcs = complianceTxId;
    metadata.properties.hcs_compliance_topic = process.env.HCS_TOPIC_ID;
    console.log(`✅ COMPLIANCE recorded for ${stoneId}: ${complianceTxId}`);
  } catch (err) {
    console.error(`❌ Could not record COMPLIANCE for ${stoneId}; nothing was pinned or minted:`, err);
    process.exitCode = 1;
    return;
  }

  // --- 4. Pin the images and documents, then the metadata JSON, then mint ---
  // The same file listed twice is pinned once. If anything fails before the
  // mint succeeds, list what was pinned, since no NFT points to it.
  const pinnedCids = [];
  let cid, ipfsUri, serials, mintTxId;
  try {
    const cidsByFile = new Map();
    for (const item of assets) {
      if (cidsByFile.has(item.file)) continue;
      const name = `${stoneId}-${path.basename(item.file)}`;
      const fileCid = await pinFile(item.file, name, item.mime, process.env.PINATA_JWT);
      cidsByFile.set(item.file, fileCid);
      pinnedCids.push(fileCid);
      console.log(`✅ Pinned ${path.basename(item.file)}: ipfs://${fileCid}`);
    }
    // The attributes come from the data, not from the form
    const pinned = buildMetadata(withGeneratedAttributes(metadata, stoneTypeById), images, cidsByFile, documents);
    cid = await pinJson(pinned, stoneId, process.env.PINATA_JWT);
    pinnedCids.push(cid);
    ipfsUri = `ipfs://${cid}`;
    console.log(`✅ Metadata pinned to IPFS: ${ipfsUri}`);

    // Mint under the class's token (supply key signs)
    const mintTx = await new TokenMintTransaction()
      .setTokenId(tokenId)
      .setMetadata([Buffer.from(ipfsUri)])
      .freezeWith(client)
      .sign(supplyKey);
    const mintResponse = await mintTx.execute(client);
    const mintReceipt = await mintResponse.getReceipt(client);
    serials = mintReceipt.serials.map(String);
    mintTxId = mintResponse.transactionId.toString();
    console.log(`✅ Minted ${className} NFT serials: ${serials} (${mintTxId})`);
  } catch (err) {
    console.error(`❌ Nothing was minted for ${stoneId}:`, err);
    if (pinnedCids.length) {
      console.error(
        `   These pins are not used by any NFT; unpin them in Pinata: ${pinnedCids
          .map((c) => `ipfs://${c}`)
          .join(", ")}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // --- 5. Submit Minting message to HCS (Birth Certificate) ---
  // The NFT exists now, so if this fails say so and keep what is needed to
  // notarize it by hand. submitEvent waits for the receipt, so a message
  // rejected at consensus lands here too.
  let hcsTxId;
  try {
    const message = buildEvent(
      { event: "MINT", stoneId, tokenId, serials, actorId: operatorId, ref: mintTxId },
      { ipfs_cid: cid, ...(isAchala && { from_stone_ids: stones.map((s) => s.stone_id) }) },
    );
    hcsTxId = await submitEvent(
      client,
      process.env.HCS_TOPIC_ID,
      message,
      loadSubmitKey(process.env),
    );
  } catch (err) {
    console.error(
      `❌ Minted serials ${serials} (${ipfsUri}) but the HCS notarization failed:`,
      err,
    );
    if (isAchala) {
      console.error(
        `   Without its MINT event the Achala's stones are not recorded as mounted: ${stones.map((s) => s.stone_id).join(", ")}.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // --- 6. Provenance logging ---
  console.table({
    stone_id: stoneId,
    event: "MINT",
    actor_id: operatorId,
    ipfs_cid: cid,
    hcs_tx_id: hcsTxId,
    timestamp: new Date().toISOString(),
  });
});
