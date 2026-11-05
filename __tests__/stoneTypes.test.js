import list from "../schema/stone-types.json" with { type: "json" };
import { STONE_TYPES, stoneTypeProblems, withStoneTypeAttributes } from "../src/mint/stoneTypes.js";
import { complianceErrors, rucCheckDigitOk } from "../src/mint/metadataValidator.js";

describe("schema/stone-types.json", () => {
  test("ids are unique and lowercase", () => {
    const ids = list.types.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[a-z][a-z0-9_]*$/));
  });

  test("every entry has both names, a known kind, and an HS code unless it is a fossil", () => {
    for (const t of list.types) {
      expect(t.name.en && t.name.es).toBeTruthy();
      expect(["mineral", "variety", "rock", "trade_name", "metal", "fossil"]).toContain(t.kind);
      if (t.kind !== "fossil") expect(t.hs_code).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/);
    }
  });

  test("a deprecated entry points to an entry that exists", () => {
    for (const t of list.types.filter((x) => x.deprecated && x.replaced_by)) {
      expect(STONE_TYPES.has(t.replaced_by)).toBe(true);
    }
  });
});

describe("stoneTypeProblems", () => {
  test("accepts a listed type, alone or with materials", () => {
    expect(stoneTypeProblems({ stone_type: "amethyst" })).toEqual([]);
    expect(
      stoneTypeProblems({
        stone_type: "quartz",
        materials: [
          { stone_type: "quartz", role: "host" },
          { stone_type: "gold", role: "inclusion" },
        ],
      }),
    ).toEqual([]);
  });

  test("needs exactly one host, and it must be the stone type", () => {
    expect(
      stoneTypeProblems({ stone_type: "quartz", materials: [{ stone_type: "gold", role: "inclusion" }] }),
    ).toEqual(["properties.materials needs exactly one host, found 0"]);
    expect(
      stoneTypeProblems({ stone_type: "quartz", materials: [{ stone_type: "pyrite", role: "host" }] }),
    ).toEqual(['the host in properties.materials ("pyrite") must be properties.stone_type ("quartz")']);
  });

  test("refuses a deprecated type and names its replacement", () => {
    const types = new Map([["old", { id: "old", kind: "mineral", deprecated: true, replaced_by: "new" }]]);
    expect(stoneTypeProblems({ stone_type: "old" }, types)).toEqual([
      'properties.stone_type "old" is deprecated; use "new"',
    ]);
  });
});

describe("withStoneTypeAttributes", () => {
  test("adds Materials only for a stone of several materials", () => {
    const metadata = { properties: { stone_type: "turquoise", specimen_form: "worked" }, attributes: [] };
    expect(withStoneTypeAttributes(metadata).attributes).toEqual([
      { trait_type: "Stone Type", value: "Turquoise" },
      { trait_type: "Form", value: "Worked" },
    ]);
  });
});

describe("RUC", () => {
  test("rucCheckDigitOk accepts real RUCs and rejects a wrong check digit", () => {
    for (const ruc of ["20100047218", "20131312955", "20100070970", "20999887768"]) {
      expect(rucCheckDigitOk(ruc)).toBe(true);
    }
    expect(rucCheckDigitOk("20999887766")).toBe(false);
    expect(rucCheckDigitOk("2010004721")).toBe(false);
  });

  test("complianceErrors reports a bad check digit at vendor_ruc", () => {
    const errors = complianceErrors({ properties: { stone_type: "quartz", vendor_ruc: "20999887766" } });
    expect(errors).toEqual([
      {
        instancePath: "/properties/vendor_ruc",
        message: '"20999887766" is not a valid RUC: its check digit does not match',
      },
    ]);
  });
});
