/**
 * @file mint/images.js
 * @description Checks uploaded photos and makes the one file pinned for each
 * (umina-achala-chain#7, #42), with sharp. Every photo becomes a single
 * version, at most maxSize px on the long side:
 * - a photo with transparency: a PNG with a reduced palette (pngQuality),
 *   so a wallet shows it on its own theme; slightly lossy, much smaller
 * - a photo without: a JPEG at jpegQuality
 * The main photo's file becomes `image`; the others go in `files[]`, each
 * with a SHA-256 checksum. No master or display pair and no thumbnails: the
 * web site and the mobile app resize what they need (decided 2026-11-05).
 * Every file is auto-rotated from the EXIF orientation and written without
 * any metadata, so no EXIF, XMP or GPS location reaches IPFS. Smaller photos
 * are never enlarged. The limits and qualities are in config/umina-achala.js
 * (images).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import ua from "../../config/umina-achala.js";

export const {
  maxFileBytes: MAX_FILE_BYTES,
  maxPixels: MAX_PIXELS,
  maxOtherImages: MAX_OTHER_IMAGES,
  maxSize: MAX_SIZE,
} = ua.images;
const { pngQuality, jpegQuality } = ua.images;

/** The accepted upload formats. */
const ACCEPTED = ["jpeg", "png", "webp"];

/** The pinned format: PNG when the photo has transparency, JPEG otherwise. */
const OUTPUT = {
  png: { ext: "png", mime: "image/png", encode: (s) => s.png({ palette: true, quality: pngQuality, effort: 10 }) },
  jpeg: { ext: "jpg", mime: "image/jpeg", encode: (s) => s.jpeg({ quality: jpegQuality, mozjpeg: true }) },
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
    return {
      problem: `${label} is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB`,
    };
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
  if (!ACCEPTED.includes(meta.format)) {
    return { problem: `${label} is ${meta.format}; only JPEG, PNG and WebP are accepted` };
  }
  if (meta.width * meta.height > MAX_PIXELS) {
    return { problem: `${label} is ${meta.width}×${meta.height} px; the limit is about 100 megapixels` };
  }
  // EXIF orientations 5 to 8 turn the photo a quarter, so its sides swap
  const turned = (meta.orientation ?? 1) >= 5;
  return {
    format: meta.format,
    hasAlpha: Boolean(meta.hasAlpha),
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
    bytes: size,
  };
}

/**
 * The file a photo will become, with its name in `stoneDir` and its size,
 * before anything is written: <nn>.png for a photo with transparency,
 * <nn>.jpg otherwise, fitted inside MAX_SIZE.
 * @param {{ index: number }} image index 1 is the main image
 * @param {{ hasAlpha: boolean, width: number, height: number }} info from inspectImage
 * @param {string} stoneDir generated/<stone_id>
 */
export function planVersion(image, info, stoneDir) {
  const output = OUTPUT[info.hasAlpha ? "png" : "jpeg"];
  return {
    file: path.join(stoneDir, `${String(image.index).padStart(2, "0")}.${output.ext}`),
    mime: output.mime,
    ...fitInside(info.width, info.height, MAX_SIZE),
  };
}

/**
 * Writes the planned file of a photo and returns it with its SHA-256
 * checksum. Re-running overwrites the file.
 */
export async function writeVersion(sourceFile, version) {
  fs.mkdirSync(path.dirname(version.file), { recursive: true });
  // rotate() applies the EXIF orientation; sharp writes no metadata unless asked
  const resized = sharp(sourceFile, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize(MAX_SIZE, MAX_SIZE, { fit: "inside", withoutEnlargement: true });
  const output = version.mime === "image/png" ? OUTPUT.png : OUTPUT.jpeg;
  await output.encode(resized).toFile(version.file);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(version.file)).digest("hex");
  return { ...version, checksum };
}
