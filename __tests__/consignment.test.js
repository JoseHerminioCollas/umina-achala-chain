import { consignmentProblems, consignmentSplit, roleProblems } from "../src/consignment.js";

describe("roleProblems", () => {
  const base = { OPERATOR_ID: "0.0.1", OPERATOR_KEY: "k", UMINA_TOKEN_ID: "0.0.9" };

  test.each([undefined, "", "seller"])("rejects role %p", (role) => {
    expect(roleProblems(base, role)).toEqual(["give the role: merchant or buyer"]);
  });

  test("checks the variables for the given role", () => {
    expect(roleProblems(base, "buyer")).toEqual(["BUYER_ID is not set", "BUYER_KEY is not set"]);
    expect(roleProblems({ ...base, MERCHANT_ID: "0.0.2", MERCHANT_KEY: "k" }, "merchant")).toEqual([]);
  });
});

describe("consignmentSplit", () => {
  test("splits 100 HBAR into 70 to the merchant and 30 to UA", () => {
    expect(consignmentSplit(10_000_000_000n)).toEqual({
      merchant: 7_000_000_000n,
      ua: 3_000_000_000n,
    });
  });

  test("shares always add up to the price, odd tinybars go to the merchant", () => {
    for (const price of [1n, 7n, 333n, 10_000_000_001n]) {
      const { merchant, ua } = consignmentSplit(price);
      expect(merchant + ua).toBe(price);
      expect(merchant).toBeGreaterThanOrEqual(ua);
    }
    expect(consignmentSplit(7n)).toEqual({ merchant: 5n, ua: 2n });
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
