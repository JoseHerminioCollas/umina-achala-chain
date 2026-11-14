import { PrivateKey } from "@hashgraph/sdk";
import {
  consignmentNfts,
  consignmentProblems,
  consignmentSplit,
  roleProblems,
  tokenVars,
} from "../src/consignment/lib.js";

const KEY = PrivateKey.generateECDSA().toStringDer();

describe("roleProblems", () => {
  const base = { OPERATOR_ID: "0.0.1", OPERATOR_KEY: KEY, UMINA_TOKEN_ID: "0.0.9" };

  test.each([undefined, "", "seller"])("rejects role %p", (role) => {
    expect(roleProblems(base, role)).toEqual(["give the role: merchant or buyer"]);
  });

  test("checks the variables for the given role", () => {
    expect(roleProblems(base, "buyer")).toEqual(["BUYER_ID is not set", "BUYER_KEY is not set"]);
    expect(roleProblems({ ...base, MERCHANT_ID: "0.0.2", MERCHANT_KEY: KEY }, "merchant")).toEqual([]);
  });

  test("associating the Achala token needs ACHALA_TOKEN_ID (umina-achala-chain#26)", () => {
    const buyer = { ...base, BUYER_ID: "0.0.6", BUYER_KEY: KEY };
    expect(roleProblems(buyer, "buyer", "achala")).toEqual(["ACHALA_TOKEN_ID is not set"]);
    expect(roleProblems({ ...buyer, ACHALA_TOKEN_ID: "0.0.8" }, "buyer", "achala")).toEqual([]);
  });
});

describe("consignmentSplit (umina-achala-chain#30)", () => {
  test("100 HBAR: legs 73.68 / 26.32, then 70 / 30 after the 5% royalty", () => {
    expect(consignmentSplit(10_000_000_000n)).toEqual({
      merchant: 7_368_421_053n,
      ua: 2_631_578_947n,
      royalty: 368_421_052n,
      merchantNet: 7_000_000_001n,
      uaNet: 2_999_999_999n,
    });
  });

  test("the legs add up to the price, and the merchant ends with at least 70%", () => {
    for (const price of [1n, 7n, 333n, 100_000_000n, 10_000_000_001n, 123_456_789_012n]) {
      const s = consignmentSplit(price);
      expect(s.merchant + s.ua).toBe(price);
      expect(s.merchantNet + s.uaNet).toBe(price);
      expect(s.merchantNet * 10n).toBeGreaterThanOrEqual(price * 7n);
    }
  });

  test("rounding gives the merchant at most one tinybar over 70%", () => {
    const price = 10_000_000_000n;
    const s = consignmentSplit(price);
    expect(s.merchantNet - (price * 7n) / 10n).toBeLessThanOrEqual(1n);
  });

  test("uses the royalty it is given; with no royalty the legs are 70 / 30", () => {
    expect(consignmentSplit(10_000_000_000n, { numerator: 0, denominator: 100 })).toEqual({
      merchant: 7_000_000_000n,
      ua: 3_000_000_000n,
      royalty: 0n,
      merchantNet: 7_000_000_000n,
      uaNet: 3_000_000_000n,
    });
  });

  test("rejects a price that is not a positive bigint", () => {
    expect(() => consignmentSplit(0n)).toThrow();
    expect(() => consignmentSplit(-1n)).toThrow();
    expect(() => consignmentSplit(100)).toThrow();
  });
});

describe("consignmentProblems", () => {
  const required = ["OPERATOR_ID", "MERCHANT_ID"];

  test("no problems with every variable set and a valid serial", () => {
    expect(
      consignmentProblems({ OPERATOR_ID: "0.0.1", MERCHANT_ID: "0.0.2" }, required, "7"),
    ).toEqual([]);
  });

  test("lists missing variables", () => {
    expect(consignmentProblems({ OPERATOR_ID: "0.0.1" }, required, "7")).toEqual([
      "MERCHANT_ID is not set",
    ]);
  });

  test.each([undefined, "", "0", "-1", "1.5", "abc"])("rejects serial %p", (serial) => {
    const env = { OPERATOR_ID: "0.0.1", MERCHANT_ID: "0.0.2" };
    expect(consignmentProblems(env, required, serial)).toEqual([
      "give the NFT serial number as a positive integer",
    ]);
  });
});

describe("consignmentNfts (umina-achala-chain#28)", () => {
  const env = { UMINA_TOKEN_ID: "0.0.2002", ACHALA_TOKEN_ID: "0.0.8008" };
  const events = [
    { event: "MINT", stone_id: "UMINA-2026-CH-03", token_id: "0.0.2002", serials: ["3"] },
    { event: "MINT", stone_id: "UMINA-2026-AU-01", token_id: "0.0.2002", serials: ["4"] },
    { event: "MINT", stone_id: "UMINA-2026-QZ-02", token_id: "0.0.2002", serials: ["5"] },
    {
      event: "MINT",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.8008",
      serials: ["1"],
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
    },
  ].map((event, i) => ({ sequence_number: i + 1, event }));

  test("an Umiña not in an Achala moves alone", () => {
    const plan = consignmentNfts(events, env, "5");
    expect(plan.problems).toEqual([]);
    expect(plan.nftIds.map(String)).toEqual(["0.0.2002/5"]);
    expect(plan.fields).toEqual({});
  });

  test("an Umiña in an Achala is refused on its own", () => {
    expect(consignmentNfts(events, env, "3").problems).toEqual([
      expect.stringContaining("UMINA-2026-CH-03 (0.0.2002/3) is mounted in Achala ACHALA-2026-RI-01"),
    ]);
  });

  test("an Achala moves with its stones and names them for the event", () => {
    const plan = consignmentNfts(events, env, "1", "achala");
    expect(plan.problems).toEqual([]);
    expect(plan.nftIds.map(String)).toEqual(["0.0.8008/1", "0.0.2002/3", "0.0.2002/4"]);
    expect(plan.stoneId).toBe("ACHALA-2026-RI-01");
    expect(plan.fields).toEqual({
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
      umina_token_id: "0.0.2002",
      umina_serials: ["3", "4"],
    });
  });

  test("a burned Achala is refused", () => {
    const burned = [...events, { sequence_number: 9, event: { event: "BURN", token_id: "0.0.8008", serials: ["1"] } }];
    expect(consignmentNfts(burned, env, "1", "achala").problems).toEqual([
      "Achala 0.0.8008/1 is burned (the piece was taken apart)",
    ]);
  });

  test("an Achala needs both token IDs", () => {
    expect(tokenVars("achala")).toEqual(["UMINA_TOKEN_ID", "ACHALA_TOKEN_ID"]);
    expect(tokenVars()).toEqual(["UMINA_TOKEN_ID"]);
  });
});
