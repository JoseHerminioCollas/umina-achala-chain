/**
 * @file mint/images.js
 * @description Checks uploaded photos and makes the versions that get pinned
 * (umina-achala-chain#7), with sharp:
 * - master, for every photo: original size, the upload's own format (JPEG
 *   and WebP at quality 95, PNG lossless), a files[] entry with a SHA-256
 *   checksum; the main image's master is the NFT's default file
 * - display, for the main image only: 1080 px on the long side, JPEG
 *   quality 82; becomes `image`, which wallets and marketplaces show
 * No thumbnails: the web site and the mobile app resize what they need
 * (decided 2026-11-05). Every version is auto-rotated from the EXIF
 * orientation and written without any metadata, so no EXIF, XMP or GPS
 * location reaches IPFS. Smaller photos are never enlarged.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PIXELS = 100_000_000;
export const MAX_OTHER_IMAGES = 5;
export const DISPLAY_SIZE = 1080;

const MASTER = {
  jpeg: { ext: "jpg", mime: "image/jpeg", encode: (s) => s.jpeg({ quality: 95 }) },
  png: { ext: "png", mime: "image/png", encode: (s) => s.png() },
  webp: { ext: "webp", mime: "image/webp", encode: (s) => s.webp({ quality: 95 }) },
};

/** The size of a photo fitted inside `max` px on its long side, never enlarged. */
export function fitInside(width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Checks an uploaded photo from its file header, without decoding it: the
 * real format (JPEG, PNG or WebP; HEIC and others refused), the file size
 * and the pixel count. Returns the photo's facts, or a problem message.
 * @param {string} file
 * @param {string} label the field, for the message, e.g. "main_image"
 */
export async function inspectImage(file, label) {
  const { size } = fs.statSync(file);
  if (size > MAX_FILE_BYTES) {
    return { problem: `${label} is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB` };
  }
  let meta;
  try {
    meta = await sharp(file, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    return { problem: `${label} is not an image sharp can read (JPEG, PNG or WebP)` };
  }
  if (meta.format === "heif") {
    return {
      problem: `${label} is HEIC (an iPhone photo); export or share it as JPEG and upload that`,
    };
  }
  if (!MASTER[meta.format]) {
    return { problem: `${label} is ${meta.format}; only JPEG, PNG and WebP are accepted` };
  }
  if (meta.width * meta.height > MAX_PIXELS) {
    return { problem: `${label} is ${meta.width}×${meta.height} px; the limit is about 100 megapixels` };
  }
  // EXIF orientations 5 to 8 turn the photo a quarter, so its sides swap
  const turned = (meta.orientation ?? 1) >= 5;
  return {
    format: meta.format,
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
    bytes: size,
  };
}

/**
 * The versions an image will become, with their file names in `stoneDir`
 * and their sizes, before anything is written: a master for every image,
 * and a display version for the main image only.
 * @param {{ index: number, main: boolean }} image index 1 is the main image
 * @param {{ format: string, width: number, height: number }} info from inspectImage
 * @param {string} stoneDir generated/<stone_id>
 */
export function planVersions(image, info, stoneDir) {
  const n = String(image.index).padStart(2, "0");
  const master = MASTER[info.format];
  return {
    master: {
      file: path.join(stoneDir, `${n}-master.${master.ext}`),
      mime: master.mime,
      ...fitInside(info.width, info.height, Infinity),
    },
    ...(image.main && {
      display: {
        file: path.join(stoneDir, `${n}-display.jpg`),
        mime: "image/jpeg",
        ...fitInside(info.width, info.height, DISPLAY_SIZE),
      },
    }),
  };
}

/**
 * Writes the planned versions of an image and returns them, the master with
 * its SHA-256 checksum. Re-running overwrites the files.
 */
export async function writeVersions(sourceFile, info, versions) {
  fs.mkdirSync(path.dirname(versions.master.file), { recursive: true });
  // rotate() applies the EXIF orientation; sharp writes no metadata unless asked
  const base = () => sharp(sourceFile, { limitInputPixels: MAX_PIXELS }).rotate();
  await MASTER[info.format].encode(base()).toFile(versions.master.file);
  if (versions.display) {
    await base()
      .resize(DISPLAY_SIZE, DISPLAY_SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(versions.display.file);
  }
  const checksum = crypto
    .createHash("sha256")
    .update(fs.readFileSync(versions.master.file))
    .digest("hex");
  return { ...versions, master: { ...versions.master, checksum } };
}
