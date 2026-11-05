import { jest } from "@jest/globals";
import { PrivateKey, Status } from "@hashgraph/sdk";

// Runs src/consignment/consignToMerchant.js itself (it calls main() on import)
// with Hedera and dotenv mocked, and records what it sends.

const operatorKey = PrivateKey.generateECDSA();
const merchantKey = PrivateKey.generateECDSA();
const treasuryKey = PrivateKey.generateECDSA();
const pub = (k) => k.publicKey.toString();
const calls = {};

// A mock transaction class: every setter records its arguments and returns
// the transaction; sign records the key; execute records the step.
function mockTransaction(name, { executeError } = {}) {
  return jest.fn().mockImplementation(() => {
    const record = { name, set: {}, signed: [] };
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
              return { getReceipt: async () => ({ status: Status.Success }) };
            };
          return (...a) => ((record.set[prop] = a.map(String)), tx);
        },
      },
    );
    return tx;
  });
}

function mockDependencies({ alreadyAssociated = false, transferError } = {}) {
  calls.steps = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({ setOperator: jest.fn().mockReturnThis(), close: calls.close }));
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => {
    const actual = jest.requireActual("@hashgraph/sdk");
    return {
      ...actual,
      Client: { forTestnet: calls.forTestnet },
      TokenAssociateTransaction: mockTransaction("associate", {
        // Built from the same SDK copy the script loads, so instanceof matches
        executeError: alreadyAssociated ? alreadyAssociatedError(actual) : undefined,
      }),
      TransferTransaction: mockTransaction("transfer", { executeError: transferError }),
      AccountAllowanceApproveTransaction: mockTransaction("approve"),
    };
  });
}

async function runScript(...args) {
  process.argv = ["node", "src/consignment/consignToMerchant.js", ...args];
  await import("../src/consignment/consignToMerchant.js");
  await new Promise((resolve) => setImmediate(resolve));
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
    });
    delete process.env.TREASURY_KEY;
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

  test("associates the merchant, transfers the serial, then grants UA the allowance", async () => {
    mockDependencies();
    await runScript("7");

    expect(calls.steps.map((s) => s.name)).toEqual(["associate", "transfer", "approve"]);
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

  test("carries on when the merchant has already associated the token", async () => {
    mockDependencies({ alreadyAssociated: true });
    await runScript("7");

    expect(calls.steps.map((s) => s.name)).toEqual(["associate", "transfer", "approve"]);
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
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });
});
