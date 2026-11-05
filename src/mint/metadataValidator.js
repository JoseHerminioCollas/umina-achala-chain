/**
 * Importable validator for HIP-412 Umiña metadata: the JSON schema, then the
 * checks a schema cannot express (umina-achala-chain#5, #14):
 * - properties.stone_type and properties.materials are ids from
 *   schema/stone-types.json, not deprecated and not fossils
 * - properties.vendor_ruc and properties.reinfo_id (the miner's RUC) have a
 *   valid SUNAT check digit; mining_concession is a 9-digit Código Único
 *   (the schema checks that)
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../../schema/hip412-umina-schema.json" with { type: "json" };
import { stoneTypeProblems } from "./stoneTypes.js";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(schema);

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
export function complianceErrors(metadata) {
  const properties = metadata?.properties ?? {};
  const errors = stoneTypeProblems(properties).map((message) => ({
    instancePath: "/properties",
    message,
  }));
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

export function validateMetadata(metadata) {
  const schemaValid = validate(metadata);
  const errors = [...(validate.errors ?? []), ...complianceErrors(metadata)];
  return { valid: schemaValid && errors.length === 0, errors: errors.length ? errors : null };
}
