/**
 * Stand-alone validator for HIP-412 Umiña metadata: the schema plus the
 * stone type and RUC checks (see metadataValidator.js).
 * Usage: node src/mint/validateMetadata.js json/example.json
 */
import fs from "fs";
import { withPlaceholderAssets } from "./lib.js";
import { validateMetadata } from "./metadataValidator.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("❌ Please provide a JSON file path");
  process.exit(1);
}

const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
// image and files are filled in at mint time, so check with placeholders
const { valid, errors } = validateMetadata(withPlaceholderAssets(metadata));

if (valid) {
  console.log("✅ Metadata JSON is valid.");
} else {
  console.error("❌ Validation failed:", errors);
  process.exit(1);
}
