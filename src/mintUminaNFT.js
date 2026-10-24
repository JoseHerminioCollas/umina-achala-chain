/**
 * @file mintUminaNFT.js
 * @description Mints an Umiña NFT on Hedera TESTNET: validates the HIP-412
 * metadata, pins its image and files to IPFS through Pinata, pins the metadata
 * itself, mints under the Umiña token, then notarizes the mint in HCS (pin,
 * mint, notarize, so the ledger never holds a MINT record for an NFT that does
 * not exist).
 *
 * The metadata file has no `image` or `files` of its own. Instead it lists the
 * item's pictures in an input-only `images` array, and optionally its receipts
 * and permits in a `documents` array. Each entry has a `file` (a path relative
 * to the metadata file) and a `description`. The files are pinned first; then
 * `image` (the first picture) and one `files[]` entry per file are set from
 * their CIDs, the two lists are dropped, and the result is pinned.
 *
 * Run from the command line:
 * node src/mintUminaNFT.js [metadata-file | --form post-file] [--out dir] [--dry-run]
 *
 * With --form the input is a simulated mint form post (see formPost.js). The
 * metadata file is generated from it into --out (default generated/) and then
 * minted. Otherwise give the path of a metadata file. One of the two is
 * required. The properties.stone_id must follow UMINA-YYYY-XX-NN. Variables come from
 * .env.testnet. --dry-run checks the environment and the metadata and sends
 * nothing, but still writes the generated metadata file.
 *
 * ## Output
 * - IPFS CID of pinned metadata
 * - Minted NFT serial number(s)
 * - Provenance log (stone_id, event, actor_id, ipfs_cid, hcs_tx_id, timestamp)
 */

import dotenv from "dotenv";
import {
  Client,
  TokenMintTransaction,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import fs from "fs";
import { validateMetadata } from "./metadataValidator.js";
import path from "path";
import {
  buildMetadata,
  checkStoneId,
  collectDocuments,
  collectImages,
  missingAssets,
  pinFile,
  pinJson,
  samplesFolderProblem,
  validateMintEnv,
} from "./mintUmina.js";
import { metadataFromForm, writeGeneratedMetadata } from "./formPost.js";
import { parseEcdsaKey } from "./uminaToken.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const formFile = option("--form");
const outDir = option("--out") ?? "generated";
const valueOptions = ["--form", "--out"];
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !valueOptions.includes(args[i - 1]),
);
let metadataFile = positional[0];
dotenv.config({ path: ".env.testnet" });

async function main() {
  let client;
  try {
    if (!formFile && !metadataFile) {
      console.error(
        "❌ Give a form post or a metadata file:\n" +
          "   node src/mintUminaNFT.js --form json/sample-form-post.json [--out dir] [--dry-run]\n" +
          "   node src/mintUminaNFT.js <metadata-file> [--dry-run]",
      );
      process.exitCode = 1;
      return;
    }
    // --- 1. Check the environment and the metadata ---
    const problems = validateMintEnv(process.env);
    if (formFile) {
      // Simulated form post: generate the metadata file from it first
      const form = JSON.parse(fs.readFileSync(formFile, "utf8"));
      const template = JSON.parse(fs.readFileSync("json/template.json", "utf8"));
      const generated = metadataFromForm(form, template, path.dirname(path.resolve(formFile)));
      metadataFile = writeGeneratedMetadata(generated, outDir);
      console.log(`✅ Metadata file generated from ${formFile}: ${metadataFile}`);
    }
    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    const baseDir = path.dirname(path.resolve(metadataFile));
    const { images, problems: imageProblems } = collectImages(metadata, baseDir);
    problems.push(...imageProblems);
    const { documents, problems: documentProblems } = collectDocuments(metadata, baseDir);
    problems.push(...documentProblems);
    const assets = [...images, ...documents];
    const samplesProblem = samplesFolderProblem(assets, path.resolve("samples"));
    if (samplesProblem) problems.push(samplesProblem);
    else missingAssets(assets).forEach((a) => problems.push(`file not found: ${a.file}`));
    // The images have no CIDs yet, so check the schema with placeholder URIs
    const { valid, errors } = validateMetadata(buildMetadata(metadata, images, undefined, documents));
    if (!valid) problems.push(`${metadataFile} failed validation: ${JSON.stringify(errors)}`);
    const idProblem = checkStoneId(metadata.properties?.stone_id);
    if (idProblem) problems.push(idProblem);
    if (problems.length) {
      console.error("❌ Problems found:");
      problems.forEach((p) => console.error(`   - ${p}`));
      process.exitCode = 1;
      return;
    }
    const stoneId = metadata.properties.stone_id;
    console.log(`✅ Environment and metadata for ${stoneId} are valid.`);

    if (dryRun) {
      assets.forEach((a) => console.log(`Would pin ${a.file} (${a.mime})`));
      console.log("Dry run, nothing sent.");
      return;
    }

    // --- 2. Connect to Hedera testnet ---
    const operatorId = process.env.OPERATOR_ID;
    const supplyKey = parseEcdsaKey(process.env.SUPPLY_KEY);
    client = Client.forTestnet().setOperator(
      operatorId,
      parseEcdsaKey(process.env.OPERATOR_KEY),
    );

    // --- 3. Pin the images and documents, then the metadata JSON ---
    // The same file listed twice is pinned once.
    const cidsByFile = new Map();
    for (const item of assets) {
      if (cidsByFile.has(item.file)) continue;
      const name = `${stoneId}-${path.basename(item.file)}`;
      const fileCid = await pinFile(item.file, name, item.mime, process.env.PINATA_JWT);
      cidsByFile.set(item.file, fileCid);
      console.log(`✅ Pinned ${path.basename(item.file)}: ipfs://${fileCid}`);
    }
    const pinned = buildMetadata(metadata, images, cidsByFile, documents);
    const cid = await pinJson(pinned, stoneId, process.env.PINATA_JWT);
    const ipfsUri = `ipfs://${cid}`;
    console.log(`✅ Metadata pinned to IPFS: ${ipfsUri}`);

    // --- 4. Mint NFT under existing Umiña Token ID (supply key signs) ---
    const mintTx = await new TokenMintTransaction()
      .setTokenId(process.env.UMINA_TOKEN_ID)
      .setMetadata([Buffer.from(ipfsUri)])
      .freezeWith(client)
      .sign(supplyKey);
    const mintResponse = await mintTx.execute(client);
    const mintReceipt = await mintResponse.getReceipt(client);
    const serials = mintReceipt.serials.map(String);
    console.log(`✅ Minted Umiña NFT serials: ${serials}`);

    // --- 5. Submit Minting message to HCS (Birth Certificate) ---
    // The NFT exists now, so if this fails say so and keep what is needed to
    // notarize it by hand.
    let hcsTxId;
    try {
      const hcsResponse = await new TopicMessageSubmitTransaction()
        .setTopicId(process.env.HCS_TOPIC_ID)
        .setMessage(
          JSON.stringify({
            event: "MINT",
            stone_id: stoneId,
            actor_id: operatorId,
            token_id: process.env.UMINA_TOKEN_ID,
            serials,
            ipfs_cid: cid,
          }),
        )
        .execute(client);
      hcsTxId = hcsResponse.transactionId.toString();
    } catch (err) {
      console.error(
        `❌ Minted serials ${serials} (${ipfsUri}) but the HCS notarization failed:`,
        err,
      );
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
  } catch (err) {
    console.error("❌ Unexpected error during minting workflow:", err);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

main();
