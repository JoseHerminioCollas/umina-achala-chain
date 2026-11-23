/**
 * @file catalog/media.js
 * @description The site's copies of each photo in the catalog
 * (umina-achala-chain#45). Loading every card's full photo from a public IPFS
 * gateway is slow and runs into its rate limits, so the catalog builder saves,
 * for each photo, once:
 *
 *   <out-dir>/media/<ipfs path>/thumb.webp    for the cards
 *   <out-dir>/media/<ipfs path>/display.webp  for the detail view
 *
 * and catalog.json maps each photo's ipfs:// URI to those paths (relative to
 * catalog.json). An IPFS file never changes, so a copy on disk is never read
 * again.
 *
 * The site never loads a file from the gateway on a visit
 * (umina-achala-chain#46), so 3D models and PDF documents are copied too,
 * unchanged:
 *
 *   <out-dir>/media/<ipfs path>/model.glb     a 3D model (model/gltf-binary)
 *   <out-dir>/media/<ipfs path>/document.pdf  a document (application/pdf)
 *
 * and catalog.json maps each to { file: <path> }.
 */

import { mkdir, readdir, rename, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import sharp from "sharp";
import ua from "../../config/umina-achala.js";
import { fetchIpfsBytes, ipfsPathOfUri } from "../ipfs.js";
import { MAX_PIXELS } from "../mint/images.js";

export const MEDIA_DIR = "media";

/** The copies made of each photo, with the square each is fitted inside. */
export const SIZES = {
  thumb: ua.catalogMedia.thumbSize,
  display: ua.catalogMedia.displaySize,
};

/** The files copied unchanged, by type, and the name each copy gets. */
export const FILE_COPIES = {
  "model/gltf-binary": "model.glb",
  "application/pdf": "document.pdf",
};

const isPhoto = (file) => typeof file?.type === "string" && file.type.startsWith("image/");

/**
 * The ipfs:// URIs of every photo in the catalog's items, each once, in order:
 * for each NFT (an item, then an Achala's stones), its image, then the image
 * files. Documents and models are not photos.
 * @param {object[]} items catalog items
 * @returns {string[]}
 */
export function photoUris(items) {
  const uris = new Set();
  for (const item of items) {
    for (const nft of [item, ...(item.stones ?? [])]) {
      const metadata = nft.metadata ?? {};
      if (metadata.image) uris.add(metadata.image);
      for (const file of metadata.files ?? []) if (isPhoto(file)) uris.add(file.uri);
    }
  }
  return [...uris];
}

/**
 * The 3D models and PDF documents in the catalog's items, each once, in
 * order: for each NFT (an item, then an Achala's stones), its files of a type
 * in FILE_COPIES. Other files are not copied.
 * @param {object[]} items catalog items
 * @returns {{ uri: string, type: string }[]}
 */
export function fileUris(items) {
  const files = new Map();
  for (const item of items) {
    for (const nft of [item, ...(item.stones ?? [])]) {
      for (const file of nft.metadata?.files ?? []) {
        if (FILE_COPIES[file?.type] && !files.has(file.uri)) files.set(file.uri, file.type);
      }
    }
  }
  return [...files].map(([uri, type]) => ({ uri, type }));
}

/**
 * Where the copy of one model or document goes, relative to catalog.json, or
 * null when the URI is not an ipfs:// path or the type is not copied.
 * @returns {{ file: string } | null}
 */
export function filePath(uri, type) {
  const ipfsPath = ipfsPathOfUri(uri);
  if (!ipfsPath || !FILE_COPIES[type]) return null;
  return { file: `${MEDIA_DIR}/${ipfsPath}/${FILE_COPIES[type]}` };
}

/**
 * Where the copies of one photo go, relative to catalog.json, or null when
 * the URI is not an ipfs:// path.
 * @returns {{ thumb: string, display: string } | null}
 */
export function mediaPaths(uri) {
  const ipfsPath = ipfsPathOfUri(uri);
  if (!ipfsPath) return null;
  const folder = `${MEDIA_DIR}/${ipfsPath}`;
  return { thumb: `${folder}/thumb.webp`, display: `${folder}/display.webp` };
}

const exists = (file) => stat(file).then(() => true, () => false);

/** Writes a temp file, then renames it: a build that stops half way leaves no broken copy. */
async function writeCopy(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, bytes);
  await rename(`${file}.tmp`, file);
}

/** One WebP copy of the photo, fitted inside size × size, never enlarged; transparency kept. */
export function webpCopy(bytes, size) {
  return sharp(bytes, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: ua.catalogMedia.webpQuality })
    .toBuffer();
}

/**
 * Makes sure both copies of one photo are in outDir. Returns { paths, read }:
 * read is false when both were already on disk (nothing downloaded). With
 * dryRun, nothing is downloaded or written; read says whether it would be.
 * A photo that cannot be read or is not an image throws.
 * @param {string} outDir the folder catalog.json is written to
 * @param {string} uri the photo's ipfs:// URI
 * @param {{ dryRun?: boolean, fetchBytes?: typeof fetchIpfsBytes }} [options]
 */
export async function ensureMedia(outDir, uri, { dryRun = false, fetchBytes = fetchIpfsBytes } = {}) {
  const paths = mediaPaths(uri);
  if (!paths) throw new Error(`${uri} is not an ipfs:// path`);
  const files = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, join(outDir, p)]));
  const missing = [];
  for (const [kind, file] of Object.entries(files)) if (!(await exists(file))) missing.push(kind);
  if (!missing.length) return { paths, read: false };
  if (dryRun) return { paths, read: true };

  const bytes = await fetchBytes(ipfsPathOfUri(uri));
  for (const kind of missing) {
    await writeCopy(files[kind], await webpCopy(bytes, SIZES[kind]));
  }
  return { paths, read: true };
}

/**
 * Makes sure the copy of one 3D model or PDF document is in outDir, the file
 * unchanged. Returns { paths, read } like ensureMedia; a file that cannot be
 * read throws.
 * @param {string} outDir the folder catalog.json is written to
 * @param {string} uri the file's ipfs:// URI
 * @param {string} type its type, a key of FILE_COPIES
 * @param {{ dryRun?: boolean, fetchBytes?: typeof fetchIpfsBytes }} [options]
 */
export async function ensureFile(outDir, uri, type, { dryRun = false, fetchBytes = fetchIpfsBytes } = {}) {
  const paths = filePath(uri, type);
  if (!paths) throw new Error(`${uri} is not an ipfs:// path`);
  const file = join(outDir, paths.file);
  if (await exists(file)) return { paths, read: false };
  if (dryRun) return { paths, read: true };
  await writeCopy(file, await fetchBytes(ipfsPathOfUri(uri)));
  return { paths, read: true };
}

/** The total size in bytes of the files under dir (0 when it does not exist). */
export async function folderSize(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? await folderSize(p) : (await stat(p)).size;
  }
  return total;
}
