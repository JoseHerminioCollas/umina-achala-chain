/**
 * @file mint/lib.js
 * @description Command line, environment checks, stone_id check and the
 * Pinata pin used by mintNFT.js, kept apart from it so they can be tested
 * without a network.
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { envProblems } from "../env.js";
import { submitKeyProblem } from "../hcs.js";
import { MAX_OTHER_IMAGES } from "./images.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";

// UMINA-YYYY-XX-NN, for example UMINA-2026-CH-03 (CH = chrysocolla)
export const STONE_ID = /^UMINA-\d{4}-[A-Z]{2}-\d{2,}$/;
// ACHALA-YYYY-XX-NN, for example ACHALA-2026-RI-01 (RI = ring)
const ACHALA_ID = /^ACHALA-\d{4}-[A-Z]{2}-\d{2,}$/;

/** What differs between minting an Umiña and an Achala. */
export const MINT_CLASSES = {
  umina: { template: "json/umina-template.json", idPattern: STONE_ID, idExample: "UMINA-2026-CH-03" },
  achala: { template: "json/achala-template.json", idPattern: ACHALA_ID, idExample: "ACHALA-2026-RI-01" },
};

const MINT_OPTIONS = {
  form: { type: "string" },
  out: { type: "string" },
  token: { type: "string" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  "images-only": { type: "boolean" },
};

/**
 * Parses the command line of mintNFT.js:
 * [metadata-file | --form post-file] [--token umina|achala] [--out dir]
 * [--force] [--dry-run | --images-only]. Returns the input and a list of
 * problems; usable only when it is empty.
 */
export function parseMintArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: MINT_OPTIONS, allowPositionals: true }));
  } catch (err) {
    return { problems: [err.message] };
  }
  const input = {
    metadataFile: positionals[0],
    formFile: values.form,
    outDir: values.out ?? "generated",
    tokenClass: values.token ?? "umina",
    force: Boolean(values.force),
    dryRun: Boolean(values["dry-run"]),
    imagesOnly: Boolean(values["images-only"]),
  };
  const problems = [];
  if (positionals.length > 1) problems.push(`give one metadata file, got ${positionals.join(", ")}`);
  if (input.formFile && input.metadataFile) problems.push("give a metadata file or --form, not both");
  if (input.dryRun && input.imagesOnly) problems.push("give --dry-run or --images-only, not both");
  const tokenProblem = tokenClassProblem(input.tokenClass);
  if (tokenProblem) problems.push(tokenProblem);
  return { ...input, problems };
}
export const PINATA_PIN_JSON = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
export const PINATA_PIN_FILE = "https://api.pinata.cloud/pinning/pinFileToIPFS";

/**
 * Checks the environment for minting a token class and returns the problems
 * found, each naming the variable that is wrong. An empty array means the
 * environment is usable. An Achala also needs UMINA_TOKEN_ID and TREASURY_ID,
 * to check its stones.
 */
export function validateMintEnv(env, tokenClass = "umina") {
  const names = ["OPERATOR_ID", TOKEN_CLASSES[tokenClass].envVar, "HCS_TOPIC_ID"];
  if (tokenClass === "achala") names.push("UMINA_TOKEN_ID", "TREASURY_ID");
  const problems = envProblems(env, [...names, "OPERATOR_KEY", "SUPPLY_KEY", "PINATA_JWT"]);

  const submitProblem = submitKeyProblem(env);
  if (submitProblem) problems.push(submitProblem);

  return problems;
}

/**
 * Returns the earlier MINT event for a stone, from a topic's events (see
 * topicEvents in mirror.js), or undefined when the stone was never minted.
 */
export function findMint(events, stoneId) {
  return events.find(({ event }) => event.event === "MINT" && event.stone_id === stoneId);
}

/**
 * Returns a problem message when the stone_id does not follow the scheme of
 * the token class, so Achala metadata is never minted as an Umiña or the
 * other way round.
 */
export function checkStoneId(stoneId, tokenClass = "umina") {
  const { idPattern, idExample } = MINT_CLASSES[tokenClass];
  if (idPattern.test(stoneId ?? "")) return null;
  const other = Object.keys(MINT_CLASSES).find((c) => MINT_CLASSES[c].idPattern.test(stoneId ?? ""));
  const hint = other ? ` (an ${TOKEN_CLASSES[other].name} ID: give --token ${other})` : "";
  return `properties.stone_id must look like ${idExample}, got "${stoneId}"${hint}`;
}

/** Pins a JSON document to IPFS through Pinata and returns its CID. */
export async function pinJson(json, name, jwt, fetchFn = fetch) {
  const response = await fetchFn(PINATA_PIN_JSON, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ pinataContent: json, pinataMetadata: { name } }),
  });
  if (!response.ok) {
    throw new Error(
      `Pinata pin failed: ${response.status} ${await response.text()}`,
    );
  }
  const { IpfsHash } = await response.json();
  return IpfsHash;
}

// Accepted photo extensions; the real type is checked with sharp later (#7)
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const REFUSED_EXTENSIONS = {
  ".gif": "GIF has 256 colours; upload a JPEG, PNG or WebP photo",
  ".heic": "HEIC (an iPhone photo) is not supported; export or share it as JPEG",
  ".heif": "HEIC (an iPhone photo) is not supported; export or share it as JPEG",
};

const DOCUMENT_TYPES = {
  ".pdf": "application/pdf",
  ".glb": "model/gltf-binary",
};

/**
 * Reads the input-only `documents` list (receipts, permits, 3D scans). It is
 * optional and has the same entry shape as `images`.
 */
export function collectDocuments(metadata, baseDir) {
  const documents = [];
  const problems = [];
  const list = metadata.documents ?? [];
  if (!Array.isArray(list)) {
    return { documents, problems: ["documents must be a list"] };
  }
  list.forEach((entry, i) => {
    if (typeof entry?.file !== "string" || !entry.file) {
      problems.push(`documents[${i}].file is missing`);
      return;
    }
    const mime = DOCUMENT_TYPES[path.extname(entry.file).toLowerCase()];
    if (!mime) {
      problems.push(`documents[${i}].file "${entry.file}" is not a supported document type (pdf, glb)`);
      return;
    }
    documents.push({
      file: path.resolve(baseDir, entry.file),
      description: entry.description ?? "",
      mime,
    });
  });
  return { documents, problems };
}

/**
 * Reads the input-only photo fields from the metadata (umina-achala-chain#7):
 * `main_image` (required; its display version becomes `image` and its master
 * is the default file) and `images` (optional, at most 5 more). Each has a
 * `file` (relative to the metadata file) and an optional `description`.
 * Returns the photos in order, the main one first with index 1, with
 * absolute paths, plus any problems.
 */
export function collectImages(metadata, baseDir) {
  const images = [];
  const problems = [];
  const add = (entry, label, main) => {
    if (typeof entry?.file !== "string" || !entry.file) {
      problems.push(`${label}.file is missing`);
      return;
    }
    const ext = path.extname(entry.file).toLowerCase();
    if (REFUSED_EXTENSIONS[ext]) {
      problems.push(`${label}.file "${entry.file}": ${REFUSED_EXTENSIONS[ext]}`);
      return;
    }
    if (!IMAGE_EXTENSIONS.includes(ext)) {
      problems.push(`${label}.file "${entry.file}" is not a JPEG, PNG or WebP photo`);
      return;
    }
    const file = path.resolve(baseDir, entry.file);
    const earlier = images.find((img) => img.file === file);
    if (earlier) {
      problems.push(`${label}.file "${entry.file}" is already ${earlier.label}; list each photo once`);
      return;
    }
    images.push({
      file,
      description: entry.description ?? "",
      label,
      main,
      index: images.length + 1,
    });
  };
  if (!metadata.main_image) {
    problems.push("main_image is required: the photo whose display version becomes `image`");
  } else {
    add(metadata.main_image, "main_image", true);
  }
  const others = metadata.images ?? [];
  if (!Array.isArray(others)) {
    problems.push("images must be a list");
  } else if (others.length > MAX_OTHER_IMAGES) {
    problems.push(`images lists ${others.length} photos; at most ${MAX_OTHER_IMAGES} besides main_image`);
  } else {
    others.forEach((entry, i) => add(entry, `images[${i}]`, false));
  }
  return { images, problems };
}

/** Returns the images whose file does not exist. */
export function missingAssets(images) {
  return images.filter((a) => !fs.existsSync(a.file));
}

/**
 * Returns a problem message when some image lives under the samples folder
 * but the folder itself does not exist (it is git-ignored, so a fresh clone
 * does not have it).
 */
export function samplesFolderProblem(images, samplesDir) {
  const inSamples = images.some((a) => a.file.startsWith(samplesDir + path.sep));
  return inSamples && !fs.existsSync(samplesDir)
    ? `${samplesDir} is missing. It is git-ignored; add your test images to it`
    : null;
}

/**
 * Builds the HIP-412 metadata that gets pinned (umina-achala-chain#7): drops
 * the input-only `main_image`, `images` and `documents`; sets `image` and
 * `type` from the main image's display version; adds one `files[]` entry per
 * photo master (the main image's is the default file; each has its SHA-256
 * `checksum` once written) and then one per document. Files with no CID yet
 * get a placeholder ipfs:// URI, so the schema can be checked before anything
 * is pinned.
 * @param {object} metadata
 * @param {Array<{ main: boolean, description: string, versions: object }>} images
 *   from collectImages, with `versions` from planVersions or writeVersions
 */
export function buildMetadata(metadata, images, cidsByFile = new Map(), documents = []) {
  const { main_image: _main, images: _images, documents: _documents, ...rest } =
    structuredClone(metadata);
  const uri = (item) => `ipfs://${cidsByFile.get(item.file) ?? "pending"}`;
  const master = (img) => ({
    uri: uri(img.versions.master),
    type: img.versions.master.mime,
    is_default_file: img.main,
    ...(img.versions.master.checksum && { checksum: img.versions.master.checksum }),
    metadata: { description: img.description },
  });
  const document = (doc) => ({ uri: uri(doc), type: doc.mime, metadata: { description: doc.description } });
  const built = {
    ...rest,
    files: [...(rest.files ?? []), ...images.map(master), ...documents.map(document)],
  };
  const main = images.find((img) => img.main);
  if (main) {
    built.image = uri(main.versions.display);
    built.type = main.versions.display.mime;
  }
  return built;
}

/**
 * For checking a metadata file before anything is pinned: drops the
 * input-only `main_image`, `images` and `documents`, and fills `image` and
 * `files` with placeholders when they are absent. Each document of a
 * supported type becomes a placeholder file of that type, as buildMetadata
 * makes it, so checks that need a document (an invoice for a metal) see it.
 */
export function withPlaceholderAssets(metadata) {
  const { main_image: _main, images: _images, documents, ...rest } = structuredClone(metadata);
  const documentFiles = (Array.isArray(documents) ? documents : []).flatMap((doc) => {
    const type = DOCUMENT_TYPES[path.extname(String(doc?.file ?? "")).toLowerCase()];
    return type ? [{ uri: "ipfs://pending", type, metadata: { description: doc.description ?? "" } }] : [];
  });
  return { ...rest, image: rest.image ?? "ipfs://pending", files: rest.files ?? documentFiles };
}

/** Pins a file to IPFS through Pinata and returns its CID. */
export async function pinFile(file, name, mime, jwt, fetchFn = fetch) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
  form.append("pinataMetadata", JSON.stringify({ name }));
  const response = await fetchFn(PINATA_PIN_FILE, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      `Pinata file pin failed for ${name}: ${response.status} ${await response.text()}`,
    );
  }
  const { IpfsHash } = await response.json();
  return IpfsHash;
}
