import fs from "fs";
import os from "os";
import path from "path";
import { metadataFromForm, writeGeneratedMetadata } from "../src/formPost.js";

const template = JSON.parse(fs.readFileSync("json/template.json", "utf8"));
const example = JSON.parse(fs.readFileSync("json/example.json", "utf8"));
const schema = JSON.parse(fs.readFileSync("schema/hip412-umina-schema.json", "utf8"));
const base = path.join(os.tmpdir(), "form-post");

const form = () => ({
  name: "Stone",
  description: "A stone",
  stone_id: "UMINA-2026-CH-99",
  hs_code: "7103.99.00.00",
  attributes: { "Stone Type": "Chrysocolla", "Weight": "8.7 carats" },
  images: [{ file: "a.jpg", description: "Front" }],
  documents: [{ file: "docs/r.pdf", description: "Receipt" }],
});

describe("metadataFromForm", () => {
  test("takes the fixed fields from the template and the rest from the post", () => {
    const metadata = metadataFromForm(form(), template, base);
    expect(metadata.name).toBe("Stone");
    expect(metadata.description).toBe("A stone");
    expect(metadata.creator).toBe(template.creator);
    expect(metadata.format).toBe(template.format);
    expect(metadata.metadata_version).toBe(template.metadata_version);
  });

  test("puts every other field under properties", () => {
    const metadata = metadataFromForm(form(), template, base);
    expect(metadata.properties).toEqual({
      stone_id: "UMINA-2026-CH-99",
      hs_code: "7103.99.00.00",
    });
  });

  test("does not inherit compliance values from the template", () => {
    const { properties } = metadataFromForm(form(), template, base);
    expect(properties.reinfo_id).toBeUndefined();
    expect(properties.vendor_ruc).toBeUndefined();
  });

  test("turns the attributes map into trait_type/value pairs", () => {
    const { attributes } = metadataFromForm(form(), template, base);
    expect(attributes).toEqual([
      { trait_type: "Stone Type", value: "Chrysocolla" },
      { trait_type: "Weight", value: "8.7 carats" },
    ]);
  });

  test("makes upload paths absolute against the post's folder", () => {
    const metadata = metadataFromForm(form(), template, base);
    expect(metadata.images).toEqual([{ file: path.join(base, "a.jpg"), description: "Front" }]);
    expect(metadata.documents).toEqual([
      { file: path.join(base, "docs/r.pdf"), description: "Receipt" },
    ]);
  });

  test("removes fields the post left empty or null, at every depth", () => {
    const post = { ...form(), reinfo_id: "", vendor_ruc: null, export_status: { is_exported: false, export_permit_id: "" } };
    const { properties } = metadataFromForm(post, template, base);
    expect(properties).not.toHaveProperty("reinfo_id");
    expect(properties).not.toHaveProperty("vendor_ruc");
    expect(properties.export_status).toEqual({ is_exported: false });
  });

  test("keeps false and 0, and drops an object that ends up empty", () => {
    const post = { ...form(), sunafil_payroll_verified: false, export_status: { current_location: "" } };
    const { properties } = metadataFromForm(post, template, base);
    expect(properties.sunafil_payroll_verified).toBe(false);
    expect(properties).not.toHaveProperty("export_status");
  });

  test("skips attributes with an empty value", () => {
    const post = { ...form(), attributes: { "Stone Type": "Chrysocolla", "Mounted By": "" } };
    expect(metadataFromForm(post, template, base).attributes).toEqual([
      { trait_type: "Stone Type", value: "Chrysocolla" },
    ]);
  });

  test("handles a post with no attributes, images or documents", () => {
    const metadata = metadataFromForm({ name: "S", stone_id: "UMINA-2026-CH-01" }, template, base);
    expect(metadata.attributes).toEqual([]);
    expect(metadata.images).toEqual([]);
    expect(metadata.documents).toEqual([]);
  });
});

describe("writeGeneratedMetadata", () => {
  test("writes <outDir>/<stone_id>.json and creates the folder", () => {
    const outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gen-")), "nested");
    const file = writeGeneratedMetadata(metadataFromForm(form(), template, base), outDir);

    expect(file).toBe(path.join(outDir, "UMINA-2026-CH-99.json"));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).properties.stone_id).toBe("UMINA-2026-CH-99");
  });

  test.each([undefined, "../escape", "a/b"])("refuses a stone_id of %s", (stoneId) => {
    const metadata = { properties: { stone_id: stoneId } };
    expect(() => writeGeneratedMetadata(metadata, os.tmpdir())).toThrow(/cannot name the metadata file/);
  });
});

describe("json/template.json", () => {
  test("has every property the schema lists and every property in example.json", () => {
    const names = [
      ...Object.keys(schema.properties.properties.properties),
      ...Object.keys(example.properties),
    ];
    names.forEach((name) => expect(template.properties).toHaveProperty(name));
  });

  test("holds the fixed fields and no values the form supplies", () => {
    expect(template.creator).toBe(example.creator);
    expect(template.format).toBe(example.format);
    expect(template.metadata_version).toBe(example.metadata_version);
    expect(template.name).toBeNull();
    expect(template.description).toBeNull();
    const leaves = (value) =>
      value && typeof value === "object" ? Object.values(value).flatMap(leaves) : [value];
    expect(leaves(template.properties).every((leaf) => leaf === null)).toBe(true);
  });

  test("has no image or files, which are set at mint time", () => {
    expect(template).not.toHaveProperty("image");
    expect(template).not.toHaveProperty("files");
  });
});
