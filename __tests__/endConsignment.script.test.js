import { jest } from "@jest/globals";
import { PrivateKey, Status } from "@hashgraph/sdk";

// Runs src/consignment/endConsignment.js itself (it calls main() on import)
// with Hedera and dotenv mocked, and records what it sends.

const operatorKey = PrivateKey.generateECDSA();
const merchantKey = PrivateKey.generateECDSA();
const pub = (k) => k.publicKey.toString();
const calls = {};

const TX_IDS = {
  revoke: "0.0.1001@1700000000.000000002",
  return: "0.0.1001@1700000000.000000003",
  hcs: "0.0.1001@1700000000.000000004",
};

// A mock transaction: every method call is recorded with its arguments as
// strings and returns the transaction; sign records the key; execute records
// the step.
function mockTransaction(name, { executeError, receiptError } = {}) {
  return jest.fn().mockImplementation(() => {
    const record = { name, set: {}, signed: [] };
    const tx = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") return undefined;
          if (prop === "freezeWith") return () => tx;
          if (prop === "sign") return async (k) => (record.signed.push(pub(k)), tx);
          if (prop === "execute")
            return async () => {
              calls.steps.push(record);
              if (executeError) throw executeError;
              return {
                transactionId: { toString: () => TX_IDS[name] },
                getReceipt: async () => {
                  if (receiptError) throw receiptError;
                  return { status: Status.Success };
                },
              };
            };
          return (...a) => ((record.set[prop] = a.map(String)), tx);
        },
      },
    );
    return tx;
  });
}

function mockDependencies({ holder = "0.0.4004", returnError, hcsReceiptError } = {}) {
  calls.steps = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({ setOperator: jest.fn().mockReturnThis(), close: calls.close }));
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => ({
    ...jest.requireActual("@hashgraph/sdk"),
    Client: { forTestnet: calls.forTestnet },
    TokenNftInfoQuery: jest.fn().mockImplementation(() => {
      const q = {
        setNftId: (id) => ((calls.infoFor = id.toString()), q),
        execute: async () => [{ accountId: { toString: () => holder } }],
      };
      return q;
    }),
    AccountAllowanceDeleteTransaction: mockTransaction("revoke"),
    TransferTransaction: mockTransaction("return", { executeError: returnError }),
    TopicMessageSubmitTransaction: mockTransaction("hcs", { receiptError: hcsReceiptError }),
  }));
}

async function runScript(...args) {
  process.argv = ["node", "src/consignment/endConsignment.js", ...args];
  await import("../src/consignment/endConsignment.js");
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

const step = (name) => calls.steps.find((s) => s.name === name);

describe("endConsignment.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: operatorKey.toStringDer(),
      TREASURY_ID: "0.0.5005",
      UMINA_TOKEN_ID: "0.0.2002",
      HCS_TOPIC_ID: "0.0.3003",
      MERCHANT_ID: "0.0.4004",
      MERCHANT_KEY: merchantKey.toStringDer(),
    });
    delete process.env.HCS_SUBMIT_KEY;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...env };
    process.argv = [...argv];
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("revokes UA's allowance, returns the NFT to the Treasury, and records TRANSFER", async () => {
    mockDependencies();
    await runScript("7");

    expect(calls.infoFor).toBe("0.0.2002/7");
    expect(calls.steps.map((s) => s.name)).toEqual(["revoke", "return", "hcs"]);
    expect(step("revoke").set.deleteAllTokenNftAllowances).toEqual(["0.0.2002/7", "0.0.4004"]);
    expect(step("revoke").signed).toEqual([pub(merchantKey)]);
    expect(step("return").set.addNftTransfer).toEqual(["0.0.2002/7", "0.0.4004", "0.0.5005"]);
    expect(step("return").signed).toEqual([pub(merchantKey)]);
    expect(JSON.parse(step("hcs").set.setMessage[0])).toEqual({
      event: "TRANSFER",
      schema_version: 1,
      token_id: "0.0.2002",
      serials: ["7"],
      actor_id: "0.0.1001",
      occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      ref: TX_IDS.return,
      from_id: "0.0.4004",
      to_id: "0.0.5005",
      reason: "consignment_ended",
    });
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test("--keep only revokes the allowance and records nothing", async () => {
    mockDependencies();
    await runScript("7", "--keep");

    expect(calls.steps.map((s) => s.name)).toEqual(["revoke"]);
    expect(console.log).toHaveBeenCalledWith(
      "ℹ️  0.0.2002/7 stays with 0.0.4004 (--keep); ownership did not change, no event recorded.",
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("does nothing when the merchant no longer holds the serial", async () => {
    mockDependencies({ holder: "0.0.6006" });
    await runScript("7");

    expect(console.error).toHaveBeenCalledWith(
      "❌ 0.0.2002/7 is held by 0.0.6006, not the merchant 0.0.4004. Nothing to end.",
    );
    expect(calls.steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("records nothing when the return fails", async () => {
    mockDependencies({ returnError: new Error("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT") });
    await runScript("7");

    expect(calls.steps.map((s) => s.name)).toEqual(["revoke", "return"]);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("already went back"));
    expect(process.exitCode).toBe(1);
  });

  test("says the NFT already went back when the event is rejected at consensus", async () => {
    mockDependencies({ hcsReceiptError: new Error("INVALID_SIGNATURE") });
    await runScript("7");

    expect(console.error).toHaveBeenCalledWith(
      `   The NFT already went back to the Treasury in ${TX_IDS.return}, but TRANSFER was not recorded.`,
    );
    expect(process.exitCode).toBe(1);
  });

  test("signs TRANSFER with HCS_SUBMIT_KEY when it is set", async () => {
    const submitKey = PrivateKey.generateECDSA();
    process.env.HCS_SUBMIT_KEY = submitKey.toStringDer();
    mockDependencies();
    await runScript("7");

    expect(step("hcs").signed).toEqual([pub(submitKey)]);
  });

  test("lists missing variables and a bad serial, and sends nothing", async () => {
    delete process.env.MERCHANT_KEY;
    process.env.HCS_SUBMIT_KEY = "not-a-key";
    mockDependencies();
    await runScript("x");

    expect(console.error).toHaveBeenCalledWith("   - MERCHANT_KEY is not set");
    expect(console.error).toHaveBeenCalledWith("   - give the NFT serial number as a positive integer");
    expect(console.error).toHaveBeenCalledWith(
      "   - HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    );
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run says what it would do and sends nothing", async () => {
    mockDependencies();
    await runScript("7", "--dry-run");

    expect(console.log).toHaveBeenCalledWith("Would return 0.0.2002/7 from 0.0.4004 to 0.0.5005");
    expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent.");
    expect(calls.forTestnet).not.toHaveBeenCalled();
  });

  test("--dry-run --keep says no event would be recorded", async () => {
    mockDependencies();
    await runScript("7", "--keep", "--dry-run");

    expect(console.log).toHaveBeenCalledWith(
      "Would leave 0.0.2002/7 with 0.0.4004 (--keep); no event recorded",
    );
  });
});
