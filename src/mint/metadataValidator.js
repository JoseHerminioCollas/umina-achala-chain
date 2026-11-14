/**
 * Importable validator for HIP-412 Umiña and Achala metadata: the class's JSON
 * schema, then the checks a schema cannot express (umina-achala-chain#5, #14,
 * #16):
 * - properties.stone_type and properties.materials are ids from
 *   schema/stone-types.json, not deprecated and not fossils
 * - properties.vendor_ruc and properties.reinfo_id (the miner's RUC) have a
 *   valid SUNAT check digit; mining_concession is a 9-digit Código Único
 *   (the schema checks that)
 * - for an Achala, achalaProblems in achala.js: each stone listed once, each
 *   metal a metal, and where the metal comes from
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { stoneTypeProblems } from "./stoneTypes.js";
import { achalaProblems } from "./achala.js";
import { TOKEN_CLASSES } from "../token/lib.js";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validators = Object.fromEntries(
  Object.entries(TOKEN_CLASSES).map(([key, { schema }]) => [key, ajv.compile(schema)]),
);

/** The class of a metadata file from its stone_id: achala for ACHALA-..., else umina. */
export function classOfMetadata(metadata) {
  const stoneId = String(metadata?.properties?.stone_id ?? "");
  const found = Object.keys(TOKEN_CLASSES).find((key) => stoneId.startsWith(`${TOKEN_CLASSES[key].idPrefix}-`));
  return found ?? "umina";
}

/**
 * True when an 11-digit RUC's last digit matches SUNAT's modulo-11 check
 * digit (weights 5 4 3 2 7 6 5 4 3 2; 10 becomes 0 and 11 becomes 1).
 */
export function rucCheckDigitOk(ruc) {
  if (!/^\d{11}$/.test(ruc)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, w, i) => total + w * Number(ruc[i]), 0);
  const digit = { 10: 0, 11: 1 }[11 - (sum % 11)] ?? 11 - (sum % 11);
  return digit === Number(ruc[10]);
}

/** The checks beyond the schema, as errors shaped like Ajv's. */
export function complianceErrors(metadata, tokenClass = "umina") {
  const properties = metadata?.properties ?? {};
  const problems =
    tokenClass === "achala"
      ? achalaProblems(properties, Array.isArray(metadata?.files) ? metadata.files : [])
      : stoneTypeProblems(properties);
  const errors = problems.map((message) => ({ instancePath: "/properties", message }));
  // REINFO profiles are tracked by the miner's RUC, so reinfo_id is a RUC too
  for (const field of ["vendor_ruc", "reinfo_id"]) {
    const ruc = properties[field];
    if (typeof ruc === "string" && /^\d{11}$/.test(ruc) && !rucCheckDigitOk(ruc)) {
      errors.push({
        instancePath: `/properties/${field}`,
        message: `"${ruc}" is not a valid RUC: its check digit does not match`,
      });
    }
  }
  return errors;
}

/**
 * Validates metadata of a token class (umina or achala) against its schema
 * and the checks above.
 */
export function validateMetadata(metadata, tokenClass = "umina") {
  const validate = validators[tokenClass];
  if (!validate) throw new Error(`no metadata schema for token class "${tokenClass}"`);
  const schemaValid = validate(metadata);
  const errors = [...(validate.errors ?? []), ...complianceErrors(metadata, tokenClass)];
  return { valid: schemaValid && errors.length === 0, errors: errors.length ? errors : null };
}
