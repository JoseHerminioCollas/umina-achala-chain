/**
 * Stand-alone validator for HIP-412 Umiña or Achala metadata: the schema plus
 * the stone type and RUC checks (see metadataValidator.js). The class comes
 * from properties.stone_id: ACHALA-... is an Achala, anything else an Umiña.
 * Usage: node src/mint/validateMetadata.js json/umina-example.json
 */
import fs from "fs";
import { withPlaceholderAssets } from "./lib.js";
import { classOfMetadata, validateMetadata } from "./metadataValidator.js";
import { TOKEN_CLASSES } from "../token/lib.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("❌ Please provide a JSON file path");
  process.exit(1);
}

const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
// image and files are filled in at mint time, so check with placeholders
const tokenClass = classOfMetadata(metadata);
const { valid, errors } = validateMetadata(withPlaceholderAssets(metadata), tokenClass);

if (valid) {
  console.log(`✅ ${TOKEN_CLASSES[tokenClass].name} metadata JSON is valid.`);
} else {
  console.error("❌ Validation failed:", errors);
  process.exit(1);
}
