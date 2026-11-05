import fs from "fs";
import { validateMetadata } from "../src/mint/metadataValidator.js";
import { withPlaceholderAssets } from "../src/mint/lib.js";

describe("mintUminaNFT.js workflow", () => {
  test("validates metadata JSON against schema", () => {
    const metadata = withPlaceholderAssets(
      JSON.parse(fs.readFileSync("./json/example.json", "utf8")),
    );
    const { valid, errors } = validateMetadata(metadata);
    expect(valid).toBe(true);
    expect(errors).toBeNull();
  });
});
