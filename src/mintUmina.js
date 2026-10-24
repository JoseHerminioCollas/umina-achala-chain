/**
 * @file mintUmina.js
 * @description Environment checks, stone_id check and the Pinata pin used by
 * mintUminaNFT.js, kept apart from it so they can be tested without a network.
 */

import fs from "fs";
import path from "path";
import { parseEcdsaKey } from "./uminaToken.js";

const HEDERA_ID = /^0\.0\.\d+$/;
// UMINA-YYYY-XX-NN, for example UMINA-2026-CH-03 (CH = chrysocolla)
export const STONE_ID = /^UMINA-\d{4}-[A-Z]{2}-\d{2,}$/;
export const PINATA_PIN_JSON = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
export const PINATA_PIN_FILE = "https://api.pinata.cloud/pinning/pinFileToIPFS";

/**
 * Checks the environment and returns the problems found, each naming the
 * variable that is wrong. An empty array means the environment is usable.
 */
export function validateMintEnv(env) {
  const problems = [];

  for (const name of ["OPERATOR_ID", "UMINA_TOKEN_ID", "HCS_TOPIC_ID"]) {
    if (!env[name]) problems.push(`${name} is missing`);
    else if (!HEDERA_ID.test(env[name]))
      problems.push(`${name} must look like 0.0.1234, got "${env[name]}"`);
  }

  for (const name of ["OPERATOR_KEY", "SUPPLY_KEY"]) {
    if (!env[name]) {
      problems.push(`${name} is missing`);
      continue;
    }
    try {
      parseEcdsaKey(env[name]);
    } catch {
      problems.push(`${name} is not an ECDSA private key (hex or DER)`);
    }
  }

  if (!env.PINATA_JWT) problems.push("PINATA_JWT is missing");

  return problems;
}

/** Returns a problem message when the stone_id does not follow the scheme. */
export function checkStoneId(stoneId) {
  return STONE_ID.test(stoneId ?? "")
    ? null
    : `properties.stone_id must look like UMINA-2026-CH-03, got "${stoneId}"`;
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

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
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
 * Reads the input-only `images` list from the metadata: each entry has a
 * `file` (relative to the metadata file) and an optional `description`.
 * Returns the images with absolute paths and MIME types, plus any problems.
 */
export function collectImages(metadata, baseDir) {
  const images = [];
  const problems = [];
  const list = metadata.images ?? [];
  if (!Array.isArray(list) || list.length === 0) {
    problems.push("images must list at least one image file");
    return { images, problems };
  }
  list.forEach((entry, i) => {
    if (typeof entry?.file !== "string" || !entry.file) {
      problems.push(`images[${i}].file is missing`);
      return;
    }
    const mime = MIME_TYPES[path.extname(entry.file).toLowerCase()];
    if (!mime) {
      problems.push(`images[${i}].file "${entry.file}" is not a supported image type`);
      return;
    }
    images.push({
      file: path.resolve(baseDir, entry.file),
      description: entry.description ?? "",
      mime,
    });
  });
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
 * Builds the HIP-412 metadata that gets pinned: drops the input-only `images`
 * and `documents` lists, adds one `files[]` entry per image (the first is the
 * default file) and then one per document, and sets `image` and `type` from
 * the first image unless the file already has them. Files with no CID yet get
 * a placeholder ipfs:// URI, so the schema can be checked before anything is
 * pinned.
 */
export function buildMetadata(metadata, images, cidsByFile = new Map(), documents = []) {
  const { images: _images, documents: _documents, ...rest } = structuredClone(metadata);
  const uri = (item) => `ipfs://${cidsByFile.get(item.file) ?? "pending"}`;
  const entry = (item, isDefault) => ({
    uri: uri(item),
    type: item.mime,
    ...(isDefault !== undefined && { is_default_file: isDefault }),
    metadata: { description: item.description },
  });
  const built = {
    ...rest,
    files: [
      ...(rest.files ?? []),
      ...images.map((img, i) => entry(img, i === 0)),
      ...documents.map((doc) => entry(doc)),
    ],
  };
  if (images.length) {
    built.image ??= uri(images[0]);
    built.type ??= images[0].mime;
  }
  return built;
}

/**
 * For checking a template that has no images yet: drops `images` and
 * `documents` and fills
 * `image` and `files` with placeholders when they are absent.
 */
export function withPlaceholderAssets(metadata) {
  const { images: _images, documents: _documents, ...rest } = structuredClone(metadata);
  return { ...rest, image: rest.image ?? "ipfs://pending", files: rest.files ?? [] };
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
