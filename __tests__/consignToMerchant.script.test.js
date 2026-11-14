import { jest } from "@jest/globals";
import { mockMirror, restoreMirror } from "../testHelpers/mockMirror.js";
import { PrivateKey, Status } from "@hashgraph/sdk";
import { actualSdk } from "../testHelpers/actualSdk.js";

// Runs src/consignment/consignToMerchant.js itself (it calls main() on import)
// with Hedera and dotenv mocked, and records what it sends.

const operatorKey = PrivateKey.generateECDSA();
const merchantKey = PrivateKey.generateECDSA();
const treasuryKey = PrivateKey.generateECDSA();
const pub = (k) => k.publicKey.toString();
const calls = {};

// A mock transaction class: every setter records its arguments and returns
// the transaction; sign records the key; execute records the step.
const TX_IDS = {
  transfer: "0.0.1001@1700000000.000000002",
  approve: "0.0.1001@1700000000.000000003",
  hcs: "0.0.1001@1700000000.000000004",
};

function mockTransaction(name, { executeError, receiptError } = {}) {
  return jest.fn().mockImplementation(() => {
    // set: the last arguments of each setter; each: every call, in order
    const record = { name, set: {}, each: {}, signed: [] };
    const tx = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") return undefined;
          if (prop === "freezeWith") return () => tx;
          if (prop === "sign")
            return async (k) => (record.signed.push(pub(k)), tx);
          if (prop === "execute")
            return async () => {
              calls.steps.push(record);
              if (executeError) throw executeError;
              return {
                transactionId: { toString: () => TX_IDS[name] ?? "0.0.1001@1.1" },
                getReceipt: async () => {
                  if (receiptError) throw receiptError;
                  return { status: Status.Success };
                },
              };
            };
          return (...a) => {
            record.set[prop] = a.map(String);
            (record.each[prop] ??= []).push(a.map(String));
            return tx;
          };
        },
      },
    );
    return tx;
  });
}

function mockDependencies({
  alreadyAssociated = false,
  transferError,
  approveError,
  hcsReceiptError,
  topicEvents = [],
  // Who holds every NFT on the mirror node: the treasury unless a test says
  holder = process.env.TREASURY_ID,
  nfts = {},
} = {}) {
  calls.mirror = mockMirror(topicEvents, { holder, nfts });
  calls.steps = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({ setOperator: jest.fn().mockReturnThis(), close: calls.close }));
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => {
    const actual = actualSdk();
    return {
      ...actual,
      Client: { forTestnet: calls.forTestnet },
      TokenAssociateTransaction: mockTransaction("associate", {
        // Built from the same SDK copy the script loads, so instanceof matches
        executeError: alreadyAssociated ? alreadyAssociatedError(actual) : undefined,
      }),
      TransferTransaction: mockTransaction("transfer", { executeError: transferError }),
      AccountAllowanceApproveTransaction: mockTransaction("approve", { executeError: approveError }),
      TopicMessageSubmitTransaction: mockTransaction("hcs", { receiptError: hcsReceiptError }),
    };
  });
}

async function runScript(...args) {
  process.argv = ["node", "src/consignment/consignToMerchant.js", ...args];
  const { done } = await import("../src/consignment/consignToMerchant.js");
  await done;
}

function alreadyAssociatedError(sdk) {
  const err = Object.create(sdk.ReceiptStatusError.prototype);
  err.status = sdk.Status.TokenAlreadyAssociatedToAccount;
  return err;
}

describe("consignToMerchant.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: operatorKey.toStringDer(),
      TREASURY_ID: "0.0.1001",
      UMINA_TOKEN_ID: "0.0.2002",
      MERCHANT_ID: "0.0.4004",
      MERCHANT_KEY: merchantKey.toStringDer(),
      HCS_TOPIC_ID: "0.0.3003",
    });
    delete process.env.TREASURY_KEY;
    delete process.env.HCS_SUBMIT_KEY;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    restoreMirror();
    process.env = { ...env };
    process.argv = [...argv];
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("associates the merchant, transfers the serial, then grants UA the allowance", async () => {
    mockDependencies();
    await runScript("7");

    expect(calls.steps.map((s) => s.name)).toEqual(["associate", "transfer", "approve", "hcs"]);
    const [associate, transfer, approve] = calls.steps;
    expect(associate.set.setAccountId).toEqual(["0.0.4004"]);
    expect(associate.signed).toEqual([pub(merchantKey)]);
    expect(transfer.set.addNftTransfer).toEqual(["0.0.2002/7", "0.0.1001", "0.0.4004"]);
    expect(transfer.signed).toEqual([]);
    expect(approve.set.approveTokenNftAllowance).toEqual(["0.0.2002/7", "0.0.4004", "0.0.1001"]);
    expect(approve.signed).toEqual([pub(merchantKey)]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test("records ISSUED_TO_OWNER after the transfer and the allowance, with the transfer as ref", async () => {
    mockDependencies();
    await runScript("7");

    const hcs = calls.steps.find((s) => s.name === "hcs");
    expect(hcs.set.setTopicId).toEqual(["0.0.3003"]);
    expect(JSON.parse(hcs.set.setMessage[0])).toEqual({
      event: "ISSUED_TO_OWNER",
      schema_version: 1,
      token_id: "0.0.2002",
      serials: ["7"],
      actor_id: "0.0.1001",
      occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      ref: TX_IDS.transfer,
      to_id: "0.0.4004",
      allowance_ref: TX_IDS.approve,
    });
    expect(hcs.signed).toEqual([]);
  });

  test("signs ISSUED_TO_OWNER with HCS_SUBMIT_KEY when it is set", async () => {
    const submitKey = PrivateKey.generateECDSA();
    process.env.HCS_SUBMIT_KEY = submitKey.toStringDer();
    mockDependencies();
    await runScript("7");

    expect(calls.steps.find((s) => s.name === "hcs").signed).toEqual([pub(submitKey)]);
  });

  test("says the NFT already moved when the allowance fails, and records nothing", async () => {
    mockDependencies({ approveError: new Error("INVALID_SIGNATURE") });
    await runScript("7");

    expect(calls.steps.map((s) => s.name)).toEqual(["associate", "transfer", "approve"]);
    expect(console.error).toHaveBeenCalledWith(
      `   0.0.2002/7 already moved to the merchant in ${TX_IDS.transfer}, but ISSUED_TO_OWNER was not recorded.`,
    );
    expect(process.exitCode).toBe(1);
  });

  test("says the NFT already moved when the event is rejected at consensus", async () => {
    mockDependencies({ hcsReceiptError: new Error("INVALID_SIGNATURE") });
    await runScript("7");

    expect(console.error).toHaveBeenCalledWith(
      `   0.0.2002/7 already moved to the merchant in ${TX_IDS.transfer}, but ISSUED_TO_OWNER was not recorded.`,
    );
    expect(process.exitCode).toBe(1);
  });

  test("carries on when the merchant has already associated the token", async () => {
    mockDependencies({ alreadyAssociated: true });
    await runScript("7");

    expect(calls.steps.map((s) => s.name)).toEqual(["associate", "transfer", "approve", "hcs"]);
    expect(process.exitCode).toBeUndefined();
  });

  test("signs the transfer with TREASURY_KEY when the treasury is another account", async () => {
    process.env.TREASURY_ID = "0.0.5005";
    process.env.TREASURY_KEY = treasuryKey.toStringDer();
    mockDependencies();
    await runScript("7");

    const transfer = calls.steps.find((s) => s.name === "transfer");
    expect(transfer.set.addNftTransfer).toEqual(["0.0.2002/7", "0.0.5005", "0.0.4004"]);
    expect(transfer.signed).toEqual([pub(treasuryKey)]);
  });

  test("requires TREASURY_KEY when the treasury is another account, and sends nothing", async () => {
    process.env.TREASURY_ID = "0.0.5005";
    mockDependencies();
    await runScript("7");

    expect(console.error).toHaveBeenCalledWith(
      "   - TREASURY_KEY is required when TREASURY_ID is not OPERATOR_ID",
    );
    expect(calls.steps).toEqual([]);
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("rejects a TREASURY_KEY that is not an ECDSA key", async () => {
    process.env.TREASURY_ID = "0.0.5005";
    process.env.TREASURY_KEY = "not-a-key";
    mockDependencies();
    await runScript("7");

    expect(console.error).toHaveBeenCalledWith(
      "   - TREASURY_KEY is not an ECDSA private key (hex or DER)",
    );
    expect(calls.steps).toEqual([]);
  });

  test("lists missing variables and a bad serial, and sends nothing", async () => {
    delete process.env.MERCHANT_KEY;
    mockDependencies();
    await runScript("seven");

    expect(console.error).toHaveBeenCalledWith("   - MERCHANT_KEY is not set");
    expect(console.error).toHaveBeenCalledWith(
      "   - give the NFT serial number as a positive integer",
    );
    expect(calls.steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run sends nothing", async () => {
    mockDependencies();
    await runScript("7", "--dry-run");

    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(calls.steps).toEqual([]);
    expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent.");
  });

  test("does not grant the allowance when the transfer fails", async () => {
    mockDependencies({ transferError: new Error("INVALID_SIGNATURE") });
    await runScript("7");

    expect(calls.steps.map((s) => s.name)).toEqual(["associate", "transfer"]);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("already moved"));
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("requires HCS_TOPIC_ID", async () => {
    delete process.env.HCS_TOPIC_ID;
    mockDependencies();
    await runScript("7");

    expect(console.error).toHaveBeenCalledWith("   - HCS_TOPIC_ID is not set");
    expect(calls.steps).toEqual([]);
  });

  // --- Mounted stones (umina-achala-chain#24) ---
  test.each([[[]], [["--dry-run"]]])("refuses to consign an Umiña mounted in an Achala %j", async (extra) => {
    process.env.ACHALA_TOKEN_ID = "0.0.8008";
    mockDependencies({ topicEvents: [
    { event: "MINT", stone_id: "UMINA-2026-CH-07", token_id: "0.0.2002", serials: ["7"] },
    { event: "MINT", stone_id: "ACHALA-2026-RI-01", token_id: "0.0.8008", serials: ["1"], from_stone_ids: ["UMINA-2026-CH-07"] },
  ] });
    await runScript("7", ...extra);

    expect(console.error).toHaveBeenCalledWith(
      "   - UMINA-2026-CH-07 (0.0.2002/7) is mounted in Achala ACHALA-2026-RI-01 (0.0.8008/1, MINT #2): " +
        "it moves only with its Achala, and is freed when the Achala is burned",
    );
    expect(calls.steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("reads the provenance topic first, also on --dry-run", async () => {
    mockDependencies();
    await runScript("7", "--dry-run");

    expect(calls.mirror[0]).toBe("https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3003");
  });

  test("refuses a serial the Treasury no longer holds, also on --dry-run", async () => {
    mockDependencies({ holder: "0.0.7007" });
    await runScript("7", "--dry-run");

    expect(console.error).toHaveBeenCalledWith(
      "   - 0.0.2002/7 is held by 0.0.7007, not the Treasury 0.0.1001. Remove the listing.",
    );
    expect(calls.steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  // --- An Achala with its stones (umina-achala-chain#28) ---
  const achalaTopic = [
    { event: "MINT", stone_id: "UMINA-2026-CH-03", token_id: "0.0.2002", serials: ["3"] },
    { event: "MINT", stone_id: "UMINA-2026-AU-01", token_id: "0.0.2002", serials: ["4"] },
    {
      event: "MINT",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.8008",
      serials: ["1"],
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
    },
  ];

  test("--token achala consigns the piece with its stones: both tokens, one transfer, one allowance, one event", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.8008";
    mockDependencies({ topicEvents: achalaTopic });
    await runScript("1", "--token", "achala");

    expect(calls.steps.map((s) => s.name)).toEqual(["associate", "associate", "transfer", "approve", "hcs"]);
    const [umina, achala, transfer, approve, hcs] = calls.steps;
    expect([umina.set.setTokenIds, achala.set.setTokenIds]).toEqual([["0.0.2002"], ["0.0.8008"]]);
    expect(transfer.each.addNftTransfer).toEqual([
      ["0.0.8008/1", "0.0.1001", "0.0.4004"],
      ["0.0.2002/3", "0.0.1001", "0.0.4004"],
      ["0.0.2002/4", "0.0.1001", "0.0.4004"],
    ]);
    expect(approve.each.approveTokenNftAllowance).toEqual([
      ["0.0.8008/1", "0.0.4004", "0.0.1001"],
      ["0.0.2002/3", "0.0.4004", "0.0.1001"],
      ["0.0.2002/4", "0.0.4004", "0.0.1001"],
    ]);
    expect(JSON.parse(hcs.set.setMessage[0])).toMatchObject({
      event: "ISSUED_TO_OWNER",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.8008",
      serials: ["1"],
      to_id: "0.0.4004",
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
      umina_token_id: "0.0.2002",
      umina_serials: ["3", "4"],
    });
    expect(process.exitCode).toBeUndefined();
  });

  test("--token achala needs ACHALA_TOKEN_ID and refuses an Achala with no MINT", async () => {
    mockDependencies({ topicEvents: achalaTopic });
    await runScript("1", "--token", "achala");
    expect(console.error).toHaveBeenCalledWith("   - ACHALA_TOKEN_ID is not set");

    jest.resetModules();
    process.env.ACHALA_TOKEN_ID = "0.0.8008";
    mockDependencies({ topicEvents: achalaTopic });
    await runScript("2", "--token", "achala");
    expect(console.error).toHaveBeenCalledWith("   - Achala 0.0.8008/2 has no MINT event on the topic");
    expect(calls.steps).toEqual([]);
  });

  test("--token achala refuses when the Treasury no longer holds one of its stones", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.8008";
    mockDependencies({ topicEvents: achalaTopic, nfts: { "0.0.2002/4": { account_id: "0.0.6006", deleted: false } } });
    await runScript("1", "--token", "achala", "--dry-run");

    expect(console.error).toHaveBeenCalledWith(
      "   - 0.0.2002/4 is held by 0.0.6006, not the Treasury 0.0.1001. Remove the listing.",
    );
    expect(calls.steps).toEqual([]);
  });

  test("refuses an unknown --token", async () => {
    mockDependencies();
    await runScript("1", "--token", "ring");

    expect(console.error).toHaveBeenCalledWith('   - --token must be umina or achala, got "ring"');
    expect(calls.steps).toEqual([]);
  });
});
