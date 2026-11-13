import fs from "fs";
import { classOfMetadata, validateMetadata } from "../src/mint/metadataValidator.js";
import { withPlaceholderAssets } from "../src/mint/lib.js";

// image and files are added at mint time, so check the template with placeholders
const load = () =>
  withPlaceholderAssets(JSON.parse(fs.readFileSync("./json/umina-example.json", "utf8")));

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
    "vendor_name",
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

  test("rejects an empty vendor_name or creator (umina-achala-chain#31)", () => {
    const noName = load();
    noName.properties.vendor_name = "";
    expect(validateMetadata(noName).valid).toBe(false);
    const noCreator = load();
    noCreator.creator = "";
    expect(validateMetadata(noCreator).valid).toBe(false);
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

describe("Achala metadata (umina-achala-chain#16)", () => {
  const achala = () => withPlaceholderAssets(JSON.parse(fs.readFileSync("json/achala-example.json", "utf8")));

  test("accepts the Achala example, and the class comes from the stone_id", () => {
    expect(validateMetadata(achala(), "achala")).toEqual({ valid: true, errors: null });
    expect(classOfMetadata(achala())).toBe("achala");
    expect(classOfMetadata({ properties: { stone_id: "UMINA-2026-CH-03" } })).toBe("umina");
  });

  test("an Achala does not pass the Umiña schema, nor an Umiña the Achala one", () => {
    expect(validateMetadata(achala(), "umina").valid).toBe(false);
    const umina = withPlaceholderAssets(JSON.parse(fs.readFileSync("json/umina-example.json", "utf8")));
    expect(validateMetadata(umina, "achala").valid).toBe(false);
  });

  test("needs at least one Umiña stone, an artisan and a piece type", () => {
    const m = achala();
    m.properties.stones = [];
    delete m.properties.artisan_rna;
    m.properties.piece_type = "crown";
    const messages = validateMetadata(m, "achala").errors.map((e) => `${e.instancePath} ${e.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        "/properties/stones must NOT have fewer than 1 items",
        "/properties must have required property 'artisan_rna'",
        "/properties/piece_type must be equal to one of the allowed values",
      ]),
    );
  });

  test("checks the vendor RUC check digit like an Umiña", () => {
    const m = achala();
    m.properties.vendor_ruc = "20999887760";
    expect(validateMetadata(m, "achala").errors[0].message).toContain("check digit");
  });

  test("a metal from an invoice passes with the invoice in documents, as the stand-alone validator sees it", () => {
    const raw = JSON.parse(fs.readFileSync("json/achala-example.json", "utf8"));
    raw.properties.metals[0].source = "invoice";
    expect(validateMetadata(withPlaceholderAssets(raw), "achala").errors[0].message).toContain(
      "add the invoice to documents",
    );
    raw.documents = [{ file: "../testnet/chrysocolla_a_store-receipt.pdf", description: "Gold invoice" }];
    expect(withPlaceholderAssets(raw).files).toEqual([
      { uri: "ipfs://pending", type: "application/pdf", metadata: { description: "Gold invoice" } },
    ]);
    expect(validateMetadata(withPlaceholderAssets(raw), "achala")).toEqual({ valid: true, errors: null });
  });
});
