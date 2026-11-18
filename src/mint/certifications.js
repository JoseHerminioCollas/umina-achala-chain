/**
 * @file mint/certifications.js
 * @description Third-party certificates of a stone's type and/or quality, in
 * properties.certifications (umina-achala-chain#38). Each entry names the
 * certifier, the report number and date, what it covers, and the PDF of the
 * report, which must be one of the post's documents: the mint pins it and
 * the entry's `document` becomes that file's ipfs:// URI.
 *
 * - documentProblems: before the mint, each `document` is in `documents`
 *   (the paths are resolved so the mint can swap in the URI)
 * - identificationProblems: a certificate of type names the stone_type
 * - certificationAttributes: `Certified by` and `Certified grade`, shown by
 *   wallets beside UA's own `Grading`, never replacing it
 * - certificationEventFields: issuer and report number for COMPLIANCE
 */

import path from "path";
import { STONE_TYPES } from "./stoneTypes.js";

export const CERTIFICATION_TRAITS = ["Certified by", "Certified grade"];

const list = (properties) => (Array.isArray(properties?.certifications) ? properties.certifications : []);

/**
 * Checks that each certificate's `document` is one of the post's documents,
 * and returns the certifications with each `document` resolved against
 * baseDir, as collectDocuments resolves the documents.
 * @param {object} properties
 * @param {Array<{ file: string }>} documents from collectDocuments (absolute paths)
 * @param {string} baseDir the folder the metadata file or post is in
 * @returns {{ problems: string[], certifications?: object[] }}
 */
export function documentProblems(properties, documents, baseDir) {
  const problems = [];
  const files = new Set(documents.map((d) => d.file));
  const certifications = list(properties).map((c, i) => {
    if (typeof c?.document !== "string" || !c.document) return c;
    const file = path.resolve(baseDir, c.document);
    if (!files.has(file)) {
      problems.push(
        `properties.certifications[${i}].document "${c.document}" is not in documents: add the report to the post's documents`,
      );
    }
    return { ...c, document: file };
  });
  return { problems, certifications: list(properties).length ? certifications : undefined };
}

const fold = (text) =>
  String(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

/** The names a certifier may use for a stone type: its id, English and Spanish names. */
function typeNames(id, types) {
  const type = types.get(id);
  const names = [id.replace(/_/g, " "), type?.name?.en, type?.name?.es].filter(Boolean);
  return [...new Set(names.map(fold))];
}

/**
 * Checks that a certificate covering the stone's type names its stone_type
 * in `identification` (as a whole word, in English, Spanish or the id), so a
 * report on a different stone is refused.
 * @param {object} properties
 * @returns {string[]}
 */
export function identificationProblems(properties, types = STONE_TYPES) {
  const stoneType = properties?.stone_type;
  if (typeof stoneType !== "string" || !types.has(stoneType)) return [];
  const names = typeNames(stoneType, types);
  const problems = [];
  list(properties).forEach((c, i) => {
    if (!Array.isArray(c?.covers) || !c.covers.includes("type")) return;
    if (typeof c.identification !== "string") return; // the schema reports it
    const text = fold(c.identification);
    const named = names.some((n) => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(text));
    if (!named) {
      problems.push(
        `properties.certifications[${i}].identification "${c.identification}" does not name the stone type "${stoneType}" (${names.join(", ")})`,
      );
    }
  });
  return problems;
}

const unique = (values) => [...new Set(values.filter((v) => typeof v === "string" && v))];

/**
 * The attributes wallets show for the certificates: `Certified by` (the
 * issuers) and, when a certificate covers quality, `Certified grade`. With
 * more than one quality certificate, each grade names its issuer.
 * @param {object} properties
 * @returns {Array<{ trait_type: string, value: string }>}
 */
export function certificationAttributes(properties) {
  const certs = list(properties);
  if (!certs.length) return [];
  const attributes = [{ trait_type: "Certified by", value: unique(certs.map((c) => c.issuer)).join(", ") }];
  const graded = certs.filter((c) => Array.isArray(c.covers) && c.covers.includes("quality") && c.grade);
  if (graded.length) {
    const value = graded.length === 1 ? graded[0].grade : graded.map((c) => `${c.grade} (${c.issuer})`).join(", ");
    attributes.push({ trait_type: "Certified grade", value });
  }
  return attributes;
}

/**
 * The COMPLIANCE event's certifications: issuer and report number of each,
 * so the certificates are on the provenance topic too. Undefined with none.
 * @param {object} properties
 */
export function certificationEventFields(properties) {
  const certs = list(properties);
  return certs.length ? certs.map((c) => ({ issuer: c.issuer, report_no: c.report_no })) : undefined;
}
