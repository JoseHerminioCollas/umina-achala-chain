import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";

// Runs src/consignment/sellConsigned.js itself (it calls main() on import)
// with Hedera and dotenv mocked, and records what it sends.

const operatorKey = PrivateKey.generateECDSA();
const buyerKey = PrivateKey.generateECDSA();
const pub = (k) => k.publicKey.toString();
const calls = {};

// A mock transaction: every method call is recorded in order and returns the
// transaction; sign records the key; execute records the step.
function mockTransaction(name, { executeError, receiptError, txId } = {}) {
  return jest.fn().mockImplementation(() => {
    const record = { name, calls: [], signed: [] };
    const tx = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") return undefined;
          if (prop === "sign") return async (k) => (record.signed.push(pub(k)), tx);
          if (prop === "execute")
            return async () => {
              calls.steps.push(record);
              if (executeError) throw executeError;
              return {
                transactionId: { toString: () => txId },
                getReceipt: async () => {
                  if (receiptError) throw receiptError;
                  return { status: "SUCCESS" };
                },
              };
            };
          return (...a) => (record.calls.push([prop, ...a]), tx);
        },
      },
    );
    return tx;
  });
}

function mockDependencies({ holder = "0.0.4004", saleError, hcsReceiptError } = {}) {
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
    TransferTransaction: mockTransaction("sale", {
      executeError: saleError,
      txId: "0.0.1001@1700000000.5",
    }),
    TopicMessageSubmitTransaction: mockTransaction("hcs", {
      receiptError: hcsReceiptError,
      txId: "0.0.1001@1700000000.6",
    }),
  }));
}

async function runScript(...args) {
  process.argv = ["node", "src/consignment/sellConsigned.js", ...args];
  await import("../src/consignment/sellConsigned.js");
  await new Promise((resolve) => setImmediate(resolve));
}

const step = (name) => calls.steps.find((s) => s.name === name);
const callsTo = (record, method) => record.calls.filter(([m]) => m === method).map(([, ...a]) => a);
const hbarMoves = (record) =>
  callsTo(record, "addHbarTransfer").map(([account, hbar]) => [
    account.toString(),
    hbar.toTinybars().toString(),
  ]);
const hcsMessage = () => JSON.parse(callsTo(step("hcs"), "setMessage")[0][0]);

describe("sellConsigned.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: operatorKey.toStringDer(),
      UMINA_TOKEN_ID: "0.0.2002",
      HCS_TOPIC_ID: "0.0.3003",
      MERCHANT_ID: "0.0.4004",
      BUYER_ID: "0.0.6006",
      BUYER_KEY: buyerKey.toStringDer(),
    });
    delete process.env.HCS_SUBMIT_KEY;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "table").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...env };
    process.argv = [...argv];
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("settles the 70 / 30 sale and the NFT in one transaction, signed by the buyer", async () => {
    mockDependencies();
    await runScript("7", "100");

    expect(calls.steps.map((s) => s.name)).toEqual(["sale", "hcs"]);
    const sale = step("sale");
    expect(hbarMoves(sale)).toEqual([
      ["0.0.6006", "-10000000000"],
      ["0.0.4004", "7000000000"],
      ["0.0.1001", "3000000000"],
    ]);
    const [[nftId, from, to]] = callsTo(sale, "addApprovedNftTransfer");
    expect([nftId.toString(), from.toString(), to.toString()]).toEqual([
      "0.0.2002/7",
      "0.0.4004",
      "0.0.6006",
    ]);
    // UA pays, so it is the allowance spender
    expect(callsTo(sale, "setTransactionId")[0][0].accountId.toString()).toBe("0.0.1001");
    expect(sale.signed).toEqual([pub(buyerKey)]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test("records a SALE event in the #10 shape, with the sale transaction as ref", async () => {
    mockDependencies();
    await runScript("7", "100");

    expect(callsTo(step("hcs"), "setTopicId")).toEqual([["0.0.3003"]]);
    expect(hcsMessage()).toEqual({
      event: "SALE",
      schema_version: 1,
      token_id: "0.0.2002",
      serials: ["7"],
      actor_id: "0.0.1001",
      occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      ref: "0.0.1001@1700000000.5",
      seller_id: "0.0.4004",
      buyer_id: "0.0.6006",
      payment: "on_chain",
      sold_for: "100",
      currency: "HBAR",
      price_tinybars: "10000000000",
      merchant_tinybars: "7000000000",
      ua_tinybars: "3000000000",
    });
    expect(step("hcs").signed).toEqual([]);
  });

  test("signs the SALE event with HCS_SUBMIT_KEY when it is set", async () => {
    const submitKey = PrivateKey.generateECDSA();
    process.env.HCS_SUBMIT_KEY = submitKey.toStringDer();
    mockDependencies();
    await runScript("7", "100");

    expect(step("hcs").signed).toEqual([pub(submitKey)]);
  });

  test("checks the holder first and sells nothing when the merchant no longer holds it", async () => {
    mockDependencies({ holder: "0.0.7007" });
    await runScript("7", "100");

    expect(calls.infoFor).toBe("0.0.2002/7");
    expect(console.error).toHaveBeenCalledWith(
      "❌ 0.0.2002/7 is held by 0.0.7007, not 0.0.4004. Remove the listing.",
    );
    expect(calls.steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("does not record a SALE when the sale fails", async () => {
    mockDependencies({ saleError: new Error("SPENDER_DOES_NOT_HAVE_ALLOWANCE") });
    await runScript("7", "100");

    expect(calls.steps.map((s) => s.name)).toEqual(["sale"]);
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("says the sale settled when the SALE event is rejected at consensus", async () => {
    mockDependencies({ hcsReceiptError: new Error("INVALID_SIGNATURE") });
    await runScript("7", "100");

    expect(console.error).toHaveBeenCalledWith(
      "❌ Sale 0.0.1001@1700000000.5 settled but the HCS notarization failed:",
      expect.objectContaining({ message: "INVALID_SIGNATURE" }),
    );
    expect(console.table).toHaveBeenCalledTimes(1); // the price table only
    expect(process.exitCode).toBe(1);
  });

  test("lists missing variables, a bad serial and a bad price, and sends nothing", async () => {
    delete process.env.BUYER_KEY;
    mockDependencies();
    await runScript("seven", "free");

    expect(console.error).toHaveBeenCalledWith("   - BUYER_KEY is not set");
    expect(console.error).toHaveBeenCalledWith(
      "   - give the NFT serial number as a positive integer",
    );
    expect(console.error).toHaveBeenCalledWith(
      "   - give the price in HBAR as a positive number",
    );
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("rejects an HCS_SUBMIT_KEY that is not an ECDSA key", async () => {
    process.env.HCS_SUBMIT_KEY = "not-a-key";
    mockDependencies();
    await runScript("7", "100");

    expect(console.error).toHaveBeenCalledWith(
      "   - HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    );
    expect(calls.steps).toEqual([]);
  });

  test("--dry-run shows the split and sends nothing", async () => {
    mockDependencies();
    await runScript("7", "100", "--dry-run");

    expect(console.table).toHaveBeenCalled();
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(calls.steps).toEqual([]);
  });
});
