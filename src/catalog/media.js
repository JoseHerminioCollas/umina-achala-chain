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
 * again. Documents and 3D models are not copied: the site links them through
 * the gateway.
 */

import { mkdir, rename, stat, writeFile } from "fs/promises";
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
    const copy = await webpCopy(bytes, SIZES[kind]);
    await mkdir(dirname(files[kind]), { recursive: true });
    // a temp file, then rename: a build that stops half way leaves no broken copy
    await writeFile(`${files[kind]}.tmp`, copy);
    await rename(`${files[kind]}.tmp`, files[kind]);
  }
  return { paths, read: true };
}
