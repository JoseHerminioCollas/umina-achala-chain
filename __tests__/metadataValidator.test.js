import fs from "fs";
import { validateMetadata } from "../src/metadataValidator.js";
import { withPlaceholderAssets } from "../src/mintUmina.js";

// image and files are added at mint time, so check the template with placeholders
const load = () =>
  withPlaceholderAssets(JSON.parse(fs.readFileSync("./json/example.json", "utf8")));

describe("validateMetadata", () => {
  test("accepts the example metadata", () => {
    const { valid, errors } = validateMetadata(load());
    expect(valid).toBe(true);
    expect(errors).toBeNull();
  });

  test.each([
    "stone_id",
    "hs_code",
    "jurisdiction",
    "legal_uri",
    "vendor_ruc",
    "mining_concession",
    "reinfo_id",
  ])("rejects metadata missing required property %s", (field) => {
    const metadata = load();
    delete metadata.properties[field];
    const { valid, errors } = validateMetadata(metadata);
    expect(valid).toBe(false);
    expect(JSON.stringify(errors)).toContain(field);
  });

  test("rejects a legal_uri that is not a URI", () => {
    const metadata = load();
    metadata.properties.legal_uri = "not a uri";
    expect(validateMetadata(metadata).valid).toBe(false);
  });

  test("rejects metadata with no properties object", () => {
    const metadata = load();
    delete metadata.properties;
    expect(validateMetadata(metadata).valid).toBe(false);
  });
});
