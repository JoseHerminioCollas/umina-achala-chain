/**
 * Importable validator for HIP-412 Umiña metadata
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../schema/hip412-umina-schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(schema);

export function validateMetadata(metadata) {
  const valid = validate(metadata);
  return { valid, errors: validate.errors };
}
