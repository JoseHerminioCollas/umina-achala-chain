import { PrivateKey } from "@hashgraph/sdk";
import { envProblems, idProblem, isHederaId, serialProblem } from "../src/env.js";

describe("isHederaId (umina-achala-chain#29)", () => {
  test.each(["0.0.1", "0.0.1234567"])("accepts %s", (id) => expect(isHederaId(id)).toBe(true));
  test.each(["", "1234", "0.0.", "0.1.5", "0.0.12a", undefined, 1234])("rejects %p", (id) =>
    expect(isHederaId(id)).toBe(false),
  );

  test("idProblem names the value", () => {
    expect(idProblem("--buyer", "abc")).toBe('--buyer must look like 0.0.1234, got "abc"');
  });
});

describe("envProblems (umina-achala-chain#29)", () => {
  const key = PrivateKey.generateECDSA().toStringDer();
  const ed25519 = PrivateKey.generateED25519().toStringDer();

  test("accepts a usable environment", () => {
    expect(envProblems({ OPERATOR_ID: "0.0.2", OPERATOR_KEY: key, PINATA_JWT: "jwt" }, [
      "OPERATOR_ID",
      "OPERATOR_KEY",
      "PINATA_JWT",
    ])).toEqual([]);
  });

  test("checks by name, in the order given: _ID an ID, _KEY an ECDSA key, the rest set", () => {
    const env = { TREASURY_ID: "1234", SUPPLY_KEY: ed25519, WIPE_KEY: "nope" };
    expect(envProblems(env, ["PINATA_JWT", "TREASURY_ID", "SUPPLY_KEY", "OPERATOR_ID", "WIPE_KEY"])).toEqual([
      "PINATA_JWT is not set",
      'TREASURY_ID must look like 0.0.1234, got "1234"',
      "SUPPLY_KEY is not an ECDSA private key (hex or DER)",
      "OPERATOR_ID is not set",
      "WIPE_KEY is not an ECDSA private key (hex or DER)",
    ]);
  });

  test("an empty string counts as not set", () => {
    expect(envProblems({ OPERATOR_ID: "" }, ["OPERATOR_ID"])).toEqual(["OPERATOR_ID is not set"]);
  });
});

describe("serialProblem", () => {
  test.each(["1", "42"])("accepts %s", (s) => expect(serialProblem(s)).toBeNull());
  test.each([undefined, "", "0", "-1", "1.5", "07", "x"])("rejects %p", (s) =>
    expect(serialProblem(s)).toBe("give the NFT serial number as a positive integer"),
  );
});
