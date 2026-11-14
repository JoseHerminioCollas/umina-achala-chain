/**
 * @file mint/prepare.js
 * @description Step 1 of mintNFT.js (umina-achala-chain#34): read the input,
 * check the environment and the metadata, and plan the image versions. It
 * sends nothing; the only file it writes is the metadata generated from a
 * form post (--form).
 */

import fs from "fs";
import path from "path";
import { validateMetadata } from "./metadataValidator.js";
import { inspectImage, planVersions } from "./images.js";
import {
  buildMetadata,
  checkStoneId,
  collectDocuments,
  collectImages,
  MINT_CLASSES,
  missingAssets,
  testnetFolderProblem,
  validateMintEnv,
} from "./lib.js";
import { metadataFromForm, writeGeneratedMetadata } from "./formPost.js";

/**
 * Prepares a mint. Returns the problems found (empty when the mint can go
 * on) and what the next steps need: the metadata, its photos with their
 * planned versions in <outDir>/<stone_id>/, its documents, and the generated
 * metadata file when the input was a form post.
 * @param {{ metadataFile?: string, formFile?: string, outDir: string, tokenClass: string, imagesOnly: boolean }} input
 * @param {object} steps the class's mint steps (umina.js or achala.js)
 * @param {Record<string, string | undefined>} env
 */
export async function prepareMint(input, steps, env) {
  const { formFile, outDir, tokenClass, imagesOnly } = input;
  let { metadataFile } = input;
  let generatedFile;

  // --images-only never leaves the machine, so it needs no credentials
  const problems = imagesOnly ? [] : validateMintEnv(env, tokenClass);
  if (formFile) {
    // Simulated form post: generate the metadata file from it first
    const form = JSON.parse(fs.readFileSync(formFile, "utf8"));
    const template = JSON.parse(fs.readFileSync(MINT_CLASSES[tokenClass].template, "utf8"));
    const generated = metadataFromForm(form, template, path.dirname(path.resolve(formFile)));
    metadataFile = generatedFile = writeGeneratedMetadata(steps.fill(generated, env), outDir);
  }
  const metadata = steps.fill(JSON.parse(fs.readFileSync(metadataFile, "utf8")), env);
  problems.push(...steps.inputProblems(metadata, env, { imagesOnly }));

  const baseDir = path.dirname(path.resolve(metadataFile));
  const { images, problems: imageProblems } = collectImages(metadata, baseDir);
  problems.push(...imageProblems);
  const { documents, problems: documentProblems } = collectDocuments(metadata, baseDir);
  problems.push(...documentProblems);
  const uploads = [...images, ...documents];
  const testnetProblem = testnetFolderProblem(uploads, path.resolve("testnet"));
  if (testnetProblem) problems.push(testnetProblem);
  else missingAssets(uploads).forEach((a) => problems.push(`file not found: ${a.file}`));
  const idProblem = checkStoneId(metadata.properties?.stone_id, tokenClass);
  if (idProblem) problems.push(idProblem);

  // Check each photo from its header (type, size, pixels) and plan its
  // versions in <outDir>/<stone_id>/ (#7); nothing is written yet
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
    const { valid, errors } = validateMetadata(buildMetadata(metadata, images, undefined, documents), tokenClass);
    if (!valid) {
      errors.forEach((e) =>
        problems.push(`${metadataFile} failed validation: ${e.instancePath || "/"} ${e.message}`),
      );
    }
  }
  return { problems, metadata, metadataFile, generatedFile, images, documents };
}
