import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { mintSteps as umina } from "../src/mint/umina.js";
import { mintSteps as achala } from "../src/mint/achala.js";
import { pinAndMint } from "../src/mint/publish.js";

// The steps of mintNFT.js that differ by token class, and pinAndMint
// (umina-achala-chain#34). The whole script is tested in mintNFT.script.test.js.

const piece = (properties = {}) => ({
  properties: {
    stone_id: "ACHALA-2026-RI-01",
    piece_type: "ring",
    artisan_rna: "RNA-1",
    vendor_ruc: "20100066603",
    hs_code: "7113.11",
    stones: [
      { stone_id: "UMINA-2026-CH-01", serial: 1 },
      { stone_id: "UMINA-2026-AM-02", serial: 2 },
    ],
    ...properties,
  },
});

describe("mint steps of an Umiña (umina.js)", () => {
  test("changes nothing before the checks and has no ledger checks", async () => {
    const metadata = { properties: { stone_id: "UMINA-2026-CH-03" } };
    expect(umina.fill(metadata, { UMINA_TOKEN_ID: "0.0.5005" })).toBe(metadata);
    expect(umina.inputProblems(metadata, {})).toEqual([]);
    expect(await umina.checkLedger(metadata, [], {}, "0.0.5005")).toEqual({ problems: [], context: {} });
    expect(umina.mintFields(metadata)).toEqual({});
    expect(umina.mintFailureNote(metadata)).toBeNull();
  });

  test("COMPLIANCE has the stone's type, RUC, concession, REINFO and HS code only", () => {
    const properties = {
      stone_type: "chrysocolla",
      vendor_ruc: "20100066603",
      mining_concession: "010000123",
      reinfo_id: "10123456789",
      hs_code: "7103.99",
      origin: "Arequipa",
    };
    expect(umina.complianceFields(properties)).toEqual({
      stone_type: "chrysocolla",
      vendor_ruc: "20100066603",
      mining_concession: "010000123",
      reinfo_id: "10123456789",
      hs_code: "7103.99",
    });
  });
});

describe("mint steps of an Achala (achala.js)", () => {
  afterEach(() => {
    delete global.fetch;
  });

  test("fills umina_token_id from UMINA_TOKEN_ID and refuses another token", () => {
    const env = { UMINA_TOKEN_ID: "0.0.5005" };
    const filled = achala.fill(piece(), env);
    expect(filled.properties.umina_token_id).toBe("0.0.5005");
    expect(achala.inputProblems(filled, env)).toEqual([]);
    const other = achala.fill(piece({ umina_token_id: "0.0.9999" }), env);
    expect(achala.inputProblems(other, env)).toEqual([
      "properties.umina_token_id 0.0.9999 is not the Umiña token 0.0.5005 (UMINA_TOKEN_ID)",
    ]);
  });

  test("a missing UMINA_TOKEN_ID is reported here only for --images-only", () => {
    expect(achala.fill(piece(), {}).properties.umina_token_id).toBeUndefined();
    expect(achala.inputProblems(piece(), {})).toEqual([]);
    expect(achala.inputProblems(piece(), {}, { imagesOnly: true })).toEqual([
      "UMINA_TOKEN_ID is missing; it fills properties.umina_token_id",
    ]);
  });

  test("MINT lists the stones, and a failed MINT says they are not mounted", () => {
    expect(achala.mintFields(piece())).toEqual({ from_stone_ids: ["UMINA-2026-CH-01", "UMINA-2026-AM-02"] });
    expect(achala.mintFailureNote(piece())).toBe(
      "Without its MINT event the Achala's stones are not recorded as mounted: UMINA-2026-CH-01, UMINA-2026-AM-02.",
    );
    expect(achala.complianceFields(piece().properties).from_stone_ids).toEqual([
      "UMINA-2026-CH-01",
      "UMINA-2026-AM-02",
    ]);
  });

  test("the ledger check stops when the mirror node cannot be read", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("offline");
    });
    const result = await achala.checkLedger(piece(), [], { UMINA_TOKEN_ID: "0.0.5005" }, "0.0.6006");
    expect(result).toEqual({ error: "Cannot check the stones on the mirror node: offline" });
  });
});

describe("pinAndMint (publish.js)", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-publish-"));
    jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
  });

  const mint = () => {
    const file = path.join(dir, "01-master.jpg");
    fs.writeFileSync(file, "jpeg");
    const asset = { file, mime: "image/jpeg" };
    return {
      stoneId: "UMINA-2026-CH-03",
      metadata: { name: "Chrysocolla", properties: { stone_id: "UMINA-2026-CH-03" } },
      images: [],
      documents: [],
      // The same file twice is pinned once
      assets: [asset, asset],
      tokenId: "0.0.5005",
      supplyKey: null,
      jwt: "jwt",
    };
  };

  test("when the metadata pin fails, the error lists the file pins already made", async () => {
    global.fetch = jest.fn(async (url) =>
      url.endsWith("pinFileToIPFS")
        ? { ok: true, json: async () => ({ IpfsHash: "QmFile1" }) }
        : { ok: false, status: 500, text: async () => "pinata says no" },
    );
    const error = await pinAndMint({}, mint()).catch((err) => err);
    expect(error.message).toBe("Pinata pin failed: 500 pinata says no");
    expect(error.pinnedCids).toEqual(["QmFile1"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("a thrown value that is not an Error still carries the pins", async () => {
    global.fetch = jest.fn(async () => {
      throw "network down";
    });
    const error = await pinAndMint({}, mint()).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("network down");
    expect(error.pinnedCids).toEqual([]);
  });
});
