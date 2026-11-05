import list from "../schema/stone-types.json" with { type: "json" };
import {
  imaId,
  mergeImaSpecies,
  STONE_TYPES,
  stoneTypeProblems,
  withStoneTypeAttributes,
} from "../src/mint/stoneTypes.js";
import { readImaExport } from "../src/mint/importIma.js";
import { complianceErrors, rucCheckDigitOk } from "../src/mint/metadataValidator.js";

describe("schema/stone-types.json", () => {
  test("ids are unique and lowercase", () => {
    const ids = list.types.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[a-z][a-z0-9_]*$/));
  });

  test("curated entries have both names, a known kind, and an HS code unless a fossil", () => {
    for (const t of list.types.filter((x) => x.source !== "ima")) {
      expect(t.name.en && t.name.es).toBeTruthy();
      expect(["mineral", "variety", "rock", "trade_name", "metal", "fossil"]).toContain(t.kind);
      if (t.kind !== "fossil") expect(t.hs_code).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/);
    }
  });

  test("imported IMA entries are minerals with an English name and their IMA species", () => {
    const imported = list.types.filter((t) => t.source === "ima");
    expect(imported.length).toBe(list.ima_import.species - 17);
    for (const t of imported) {
      expect(t.kind).toBe("mineral");
      expect(t.name.en).toBeTruthy();
      expect(t.ima_species).toBe(t.name.en.toLowerCase());
      expect(t.id).toBe(imaId(t.name.en));
    }
  });

  test("every curated ima_species names a species in the import", () => {
    const species = new Set(list.types.map((t) => t.ima_species).filter(Boolean));
    const imported = new Set(list.types.filter((t) => t.source === "ima").map((t) => t.ima_species));
    for (const t of list.types.filter((x) => x.source !== "ima" && x.ima_species)) {
      expect(species.has(t.ima_species)).toBe(true);
      // the curated entry itself is the species, or the species is imported or curated
      expect(imported.has(t.ima_species) || list.types.some((x) => x.id === imaId(t.ima_species))).toBe(true);
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

describe("IMA import", () => {
  const curated = { id: "quartz", name: { en: "Quartz", es: "Cuarzo" }, kind: "mineral", hs_code: "7103.99.00.00" };
  const info = { file: "x.csv" };

  test("imaId makes plain lowercase ids", () => {
    expect(imaId("Abenakiite-(Ce)")).toBe("abenakiite_ce");
    expect(imaId("Krut'aite")).toBe("krutaite");
    expect(imaId("Achávalite")).toBe("achavalite");
  });

  test("adds species, keeps curated entries as they are, records the import", () => {
    const { list: merged, added, curatedKept } = mergeImaSpecies(
      { types: [curated] },
      ["Quartz", "Abellaite"],
      info,
    );
    expect(merged.types).toEqual([
      curated,
      { id: "abellaite", name: { en: "Abellaite" }, kind: "mineral", ima_species: "abellaite", source: "ima" },
    ]);
    expect(added).toBe(1);
    expect(curatedKept).toEqual(["quartz"]);
    expect(merged.ima_import).toEqual(info);
  });

  test("a re-import keeps every id: a species no longer exported is deprecated, not deleted", () => {
    const first = mergeImaSpecies({ types: [curated] }, ["Abellaite", "Abelsonite"], info).list;
    const { list: second, added, deprecated } = mergeImaSpecies(first, ["Abellaite"], info);
    expect(added).toBe(0);
    expect(deprecated).toEqual(["abelsonite"]);
    expect(second.types.find((t) => t.id === "abelsonite").deprecated).toBe(true);
    expect(second.types).toHaveLength(3);
  });

  test("refuses two names that give the same id", () => {
    expect(() => mergeImaSpecies({ types: [] }, ["Abc-(Y)", "Abc (Y)"], info)).toThrow(
      'IMA names "Abc-(Y)" and "Abc (Y)" both give the id "abc_y"',
    );
  });

  test("readImaExport reads the one-column RRUFF export", () => {
    expect(readImaExport('﻿"mineral_name"\r\n"Abellaite"\r\n"Krut\'aite"\r\n')).toEqual([
      "Abellaite",
      "Krut'aite",
    ]);
    expect(() => readImaExport('"name","formula"\n')).toThrow(/mineral_name/);
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
