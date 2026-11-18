import { achalaName, builtName, typedNameProblem, uminaName } from "../src/mint/names.js";
import { withPlaceholderAssets } from "../src/mint/lib.js";

// The NFT name, built by the mint (umina-achala-chain#38)

describe("uminaName", () => {
  test("the stone type's English name and the stone_id, no # number", () => {
    expect(uminaName({ stone_type: "chrysocolla", stone_id: "UMINA-2026-CH-01" })).toBe("Chrysocolla · UMINA-2026-CH-01");
    expect(uminaName({ stone_type: "opal", stone_id: "UMINA-2026-OP-01" })).toBe("Opal · UMINA-2026-OP-01");
  });
});

describe("achalaName", () => {
  const types = new Map([
    ["UMINA-2026-CH-01", "chrysocolla"],
    ["UMINA-2026-AM-02", "amethyst"],
    ["UMINA-2026-QZ-03", "quartz"],
    ["UMINA-2026-AU-01", "gold"],
  ]);
  const piece = (fields) => ({ stone_id: "ACHALA-2026-PE-01", piece_type: "pendant", ...fields });

  test("piece type, its stones and its metal", () => {
    const properties = piece({
      stones: [{ stone_id: "UMINA-2026-CH-01" }],
      metals: [{ stone_type: "silver", source: "invoice" }],
    });
    expect(achalaName(properties, types)).toBe("Pendant, chrysocolla in silver · ACHALA-2026-PE-01");
  });

  test("several stones, each type once", () => {
    const properties = piece({
      piece_type: "ring",
      stone_id: "ACHALA-2026-RI-01",
      stones: [{ stone_id: "UMINA-2026-CH-01" }, { stone_id: "UMINA-2026-AM-02" }, { stone_id: "UMINA-2026-QZ-03" }],
    });
    expect(achalaName(properties, types)).toBe("Ring, chrysocolla, amethyst and quartz · ACHALA-2026-RI-01");
  });

  test("a stone that is the piece's metal, like a gold nugget, is named as the metal", () => {
    const properties = piece({
      stones: [{ stone_id: "UMINA-2026-CH-01" }, { stone_id: "UMINA-2026-AU-01" }],
      metals: [{ stone_type: "gold", source: "umina", stone_id: "UMINA-2026-AU-01" }],
    });
    expect(achalaName(properties, types)).toBe("Pendant, chrysocolla in gold · ACHALA-2026-PE-01");
  });

  test("a stone whose type is not known yet is named by its stone_id", () => {
    expect(achalaName(piece({ stones: [{ stone_id: "UMINA-2026-CH-01" }] }))).toBe(
      "Pendant, UMINA-2026-CH-01 · ACHALA-2026-PE-01",
    );
  });
});

describe("builtName and withPlaceholderAssets", () => {
  test("chooses the class by the stone_id", () => {
    expect(builtName({ properties: { stone_type: "opal", stone_id: "UMINA-2026-OP-01" } })).toBe("Opal · UMINA-2026-OP-01");
    expect(builtName({ properties: { piece_type: "ring", stone_id: "ACHALA-2026-RI-01" } })).toBe("Ring · ACHALA-2026-RI-01");
  });

  test("the placeholder metadata carries the built name, as the mint would", () => {
    const metadata = { properties: { stone_type: "opal", stone_id: "UMINA-2026-OP-01" } };
    expect(withPlaceholderAssets(metadata).name).toBe("Opal · UMINA-2026-OP-01");
  });
});

describe("typedNameProblem", () => {
  test("refuses a typed name and accepts none, null or empty", () => {
    expect(typedNameProblem({ name: "Umiña Stone #99" }, "post.json")).toContain('post.json has a name ("Umiña Stone #99")');
    expect(typedNameProblem({}, "post.json")).toBeNull();
    expect(typedNameProblem({ name: null }, "post.json")).toBeNull();
    expect(typedNameProblem({ name: "" }, "post.json")).toBeNull();
  });
});
