/**
 * @file mint/prepare.js
 * @description Step 1 of mintNFT.js (umina-achala-chain#34): read the input,
 * check the environment and the metadata, and plan the image files. It
 * sends nothing; the only file it writes is the metadata generated from a
 * form post (--form).
 */

import fs from "fs";
import path from "path";
import { validateMetadata } from "./metadataValidator.js";
import { inspectImage, planVersion } from "./images.js";
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
import { documentProblems as certificationDocumentProblems } from "./certifications.js";
import { typedNameProblem } from "./names.js";

/**
 * Prepares a mint. Returns the problems found (empty when the mint can go
 * on) and what the next steps need: the metadata, its photos with their
 * planned files in <outDir>/<stone_id>/, its documents, and the generated
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
    const named = typedNameProblem(form, formFile);
    if (named) problems.push(named);
    const template = JSON.parse(fs.readFileSync(MINT_CLASSES[tokenClass].template, "utf8"));
    const generated = metadataFromForm(form, template, path.dirname(path.resolve(formFile)));
    metadataFile = generatedFile = writeGeneratedMetadata(steps.fill(generated, env), outDir);
  }
  const read = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  if (!formFile) {
    const named = typedNameProblem(read, metadataFile);
    if (named) problems.push(named);
  }
  const metadata = steps.fill(read, env);
  problems.push(...steps.inputProblems(metadata, env, { imagesOnly }));

  const baseDir = path.dirname(path.resolve(metadataFile));
  const { images, problems: imageProblems } = collectImages(metadata, baseDir);
  problems.push(...imageProblems);
  const { documents, problems: documentProblems } = collectDocuments(metadata, baseDir);
  problems.push(...documentProblems);
  // Each certificate's report must be one of the documents; its path is
  // resolved so buildMetadata can swap in the pinned URI (#38)
  const certified = certificationDocumentProblems(metadata.properties, documents, baseDir);
  problems.push(...certified.problems);
  if (certified.certifications) metadata.properties.certifications = certified.certifications;
  const uploads = [...images, ...documents];
  const testnetProblem = testnetFolderProblem(uploads, path.resolve("testnet"));
  if (testnetProblem) problems.push(testnetProblem);
  else missingAssets(uploads).forEach((a) => problems.push(`file not found: ${a.file}`));
  const idProblem = checkStoneId(metadata.properties?.stone_id, tokenClass);
  if (idProblem) problems.push(idProblem);

  // Check each photo from its header (type, size, pixels, transparency) and
  // plan its file in <outDir>/<stone_id>/ (#7, #42); nothing is written yet
  if (!problems.length) {
    const stoneDir = path.join(outDir, metadata.properties.stone_id);
    for (const image of images) {
      const info = await inspectImage(image.file, image.label);
      if (info.problem) problems.push(info.problem);
      else Object.assign(image, { info, version: planVersion(image, info, stoneDir) });
    }
  }
  if (!problems.length) {
    // The files have no CIDs yet, so check the schema with placeholder URIs;
    // the name is built as the mint builds it (#38)
    const { valid, errors } = validateMetadata(buildMetadata(steps.withName(metadata), images, undefined, documents), tokenClass);
    if (!valid) {
      errors.forEach((e) =>
        problems.push(`${metadataFile} failed validation: ${e.instancePath || "/"} ${e.message}`),
      );
    }
  }
  return { problems, metadata, metadataFile, generatedFile, images, documents };
}
