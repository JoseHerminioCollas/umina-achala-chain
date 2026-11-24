import { PrivateKey } from "@hashgraph/sdk";
import { roleProblems, tokenVars } from "../src/token/associate.js";

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

  test("--token achala needs both tokens: an Achala moves with its stones (umina-achala-chain#26, #28)", () => {
    const buyer = { ...base, BUYER_ID: "0.0.6", BUYER_KEY: KEY };
    expect(roleProblems(buyer, "buyer", "achala")).toEqual(["ACHALA_TOKEN_ID is not set"]);
    expect(roleProblems({ ...buyer, ACHALA_TOKEN_ID: "0.0.8" }, "buyer", "achala")).toEqual([]);
    const { UMINA_TOKEN_ID, ...noUmina } = buyer;
    expect(roleProblems({ ...noUmina, ACHALA_TOKEN_ID: "0.0.8" }, "buyer", "achala")).toEqual([
      "UMINA_TOKEN_ID is not set",
    ]);
  });
});

describe("tokenVars", () => {
  test("an Achala also needs the Umiña token, since its stones move with it", () => {
    expect(tokenVars()).toEqual(["UMINA_TOKEN_ID"]);
    expect(tokenVars("achala")).toEqual(["UMINA_TOKEN_ID", "ACHALA_TOKEN_ID"]);
  });
});
