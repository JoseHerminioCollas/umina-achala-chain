/**
 * @file formPost.js
 * @description Turns a mint form post into the metadata JSON file that
 * mintUminaNFT.js reads. The post is simulated by a JSON file: the form's text
 * fields, plus the uploaded `images` and `documents`, each with a `file` (a
 * path relative to the post) and a `description`.
 *
 * The metadata starts as a copy of json/template.json (fixed fields keep their
 * values, everything the form supplies is null) and is filled from the post.
 * Fields the post leaves empty are removed, so "absent" means "not provided"
 * and a missing compliance field fails validation instead of passing as "".
 */

import fs from "fs";
import path from "path";

const RESERVED = ["name", "description", "attributes", "images", "documents"];

/** Converts the form's `attributes` map into pairs, skipping empty values. */
function toAttributes(attributes = {}) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([trait_type, value]) => ({ trait_type, value }));
}

/** Makes upload paths absolute, so the metadata file can live anywhere. */
function resolveUploads(list = [], baseDir) {
  return list.map((entry) => ({
    ...entry,
    file: typeof entry?.file === "string" ? path.resolve(baseDir, entry.file) : entry?.file,
  }));
}

const isEmpty = (value) => value === null || value === undefined || value === "";

/** Removes null and "" values, and objects left empty, at every depth. */
function prune(object) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    const kept =
      value && typeof value === "object" && !Array.isArray(value) ? prune(value) : value;
    const emptyObject =
      kept && typeof kept === "object" && !Array.isArray(kept) && !Object.keys(kept).length;
    if (!isEmpty(kept) && !emptyObject) result[key] = kept;
  }
  return result;
}

/**
 * Fills a copy of the template from a form post. Every field other than name,
 * description, attributes, images and documents goes under `properties`.
 * Empty fields are removed.
 */
export function metadataFromForm(form, template, baseDir) {
  const filled = structuredClone(template);
  filled.name = form.name;
  filled.description = form.description;
  filled.properties = prune({
    ...filled.properties,
    ...Object.fromEntries(Object.entries(form).filter(([key]) => !RESERVED.includes(key))),
  });
  filled.attributes = toAttributes(form.attributes);
  filled.images = resolveUploads(form.images, baseDir);
  filled.documents = resolveUploads(form.documents, baseDir);
  return prune(filled);
}

/** Writes the generated metadata to <outDir>/<stone_id>.json and returns the path. */
export function writeGeneratedMetadata(metadata, outDir) {
  const stoneId = metadata.properties?.stone_id;
  if (typeof stoneId !== "string" || !/^[\w.-]+$/.test(stoneId)) {
    throw new Error(`cannot name the metadata file: stone_id is "${stoneId}"`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${stoneId}.json`);
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2) + "\n");
  return file;
}
