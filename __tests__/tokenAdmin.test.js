import { PrivateKey } from "@hashgraph/sdk";
import { adminEnvProblems, buildRoyaltyFee, parseAdminArgs } from "../src/token/lib.js";

const key = PrivateKey.generateECDSA().toStringDer();
const env = (extra = {}) => ({
  OPERATOR_ID: "0.0.1001",
  OPERATOR_KEY: key,
  UMINA_TOKEN_ID: "0.0.2002",
  TREASURY_ID: "0.0.1001",
  HCS_TOPIC_ID: "0.0.3003",
  FEE_SCHEDULE_KEY: key,
  PAUSE_KEY: key,
  WIPE_KEY: key,
  SUPPLY_KEY: key,
  ...extra,
});

describe("parseAdminArgs", () => {
  test("fees: the fallback fee is required, the royalty defaults to 5%", () => {
    expect(parseAdminArgs(["fees", "--fallback-hbar", "41.5"])).toMatchObject({
      command: "fees",
      fallbackHbar: "41.5",
      royalty: { numerator: 5, denominator: 100 },
      problems: [],
    });
    expect(parseAdminArgs(["fees", "--fallback-hbar", "40", "--royalty", "7"]).royalty.numerator).toBe(7);
    expect(parseAdminArgs(["fees"]).problems).toEqual([
      "--fallback-hbar is required (the fallback fee in HBAR)",
    ]);
  });

  test("fees: rejects a bad amount or royalty", () => {
    expect(parseAdminArgs(["fees", "--fallback-hbar", "0", "--royalty", "0"]).problems).toEqual([
      '--fallback-hbar must be a positive HBAR amount, got "0"',
      '--royalty must be a whole percentage from 1 to 100, got "0"',
    ]);
    expect(parseAdminArgs(["fees", "--fallback-hbar", "5", "--royalty", "2.5"]).problems).toEqual([
      '--royalty must be a whole percentage from 1 to 100, got "2.5"',
    ]);
  });

  test("pause and unpause take nothing else", () => {
    expect(parseAdminArgs(["pause"]).problems).toEqual([]);
    expect(parseAdminArgs(["unpause", "7", "--reason", "x"]).problems).toEqual([
      "--reason is not used with unpause",
      "unpause does not take a serial number",
    ]);
  });

  test("wipe needs a serial, the account and a reason", () => {
    expect(
      parseAdminArgs(["wipe", "7", "--account", "0.0.6006", "--reason", "Stolen, police report 123"]),
    ).toMatchObject({ serial: "7", account: "0.0.6006", reason: "Stolen, police report 123", problems: [] });
    expect(parseAdminArgs(["wipe", "x", "--account", "6006"]).problems).toEqual([
      "give the NFT serial number as a positive integer",
      "--reason is required: it is recorded in the BURN event",
      '--account must look like 0.0.1234, got "6006"',
    ]);
  });

  test("burn needs a serial and a reason, not an account", () => {
    expect(parseAdminArgs(["burn", "7", "--reason", "Re-mint with corrected metadata"]).problems).toEqual([]);
    expect(parseAdminArgs(["burn", "7", "--reason", "x".repeat(201), "--account", "0.0.6"]).problems).toEqual([
      "--account is not used with burn",
      "--reason must be at most 200 characters",
    ]);
  });

  test("--token picks the class, umina by default", () => {
    expect(parseAdminArgs(["pause"]).tokenClass).toBe("umina");
    expect(parseAdminArgs(["burn", "3", "--reason", "Disassembled", "--token", "achala"]).tokenClass).toBe("achala");
    expect(parseAdminArgs(["pause", "--token", "gems"]).problems).toEqual([
      '--token must be umina or achala, got "gems"',
    ]);
    expect(parseAdminArgs(["pause", "--token=achala"]).tokenClass).toBe("achala");
    expect(parseAdminArgs(["pause", "--token", "constructor"]).problems).toEqual([
      '--token must be umina or achala, got "constructor"',
    ]);
  });

  test("an Achala command needs ACHALA_TOKEN_ID, not UMINA_TOKEN_ID", () => {
    const e = env();
    delete e.UMINA_TOKEN_ID;
    expect(adminEnvProblems(e, "burn", "achala")).toEqual(["ACHALA_TOKEN_ID is not set"]);
    expect(adminEnvProblems({ ...e, ACHALA_TOKEN_ID: "0.0.4004" }, "burn", "achala")).toEqual([]);
  });

  test("needs a known command", () => {
    expect(parseAdminArgs(["delete"]).problems).toEqual([
      "give the command: fees, pause, unpause, wipe, burn",
    ]);
  });
});

describe("adminEnvProblems", () => {
  test("accepts a complete environment for every command", () => {
    for (const command of ["fees", "pause", "unpause", "wipe", "burn"]) {
      expect(adminEnvProblems(env(), command)).toEqual([]);
    }
  });

  test("needs only the key of the command, and the topic only when it records", () => {
    const minimal = { OPERATOR_ID: "0.0.1001", OPERATOR_KEY: key, UMINA_TOKEN_ID: "0.0.2002", PAUSE_KEY: key };
    expect(adminEnvProblems(minimal, "pause")).toEqual([]);
    expect(adminEnvProblems(minimal, "burn")).toEqual([
      "SUPPLY_KEY is not set",
      "TREASURY_ID is not set",
      "HCS_TOPIC_ID is not set",
    ]);
  });

  test("names a key that is not ECDSA and a bad submit key", () => {
    expect(adminEnvProblems(env({ WIPE_KEY: "nope", HCS_SUBMIT_KEY: "nope" }), "wipe")).toEqual([
      "WIPE_KEY is not an ECDSA private key (hex or DER)",
      "HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    ]);
  });
});

describe("buildRoyaltyFee", () => {
  test("builds the royalty with the HBAR fallback fee, 5% by default", () => {
    const fee = buildRoyaltyFee("0.0.1001", "38");
    expect([fee.numerator.toNumber(), fee.denominator.toNumber()]).toEqual([5, 100]);
    expect(fee.feeCollectorAccountId.toString()).toBe("0.0.1001");
    expect(fee.fallbackFee.hbarAmount.toTinybars().toString()).toBe("3800000000");
    expect(buildRoyaltyFee("0.0.1001", "1", { numerator: 7, denominator: 100 }).numerator.toNumber()).toBe(7);
  });
});
