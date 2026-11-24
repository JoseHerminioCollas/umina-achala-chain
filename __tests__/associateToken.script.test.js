import { jest } from "@jest/globals";
import { PrivateKey, Status } from "@hashgraph/sdk";
import { actualSdk } from "../testHelpers/actualSdk.js";

// Runs src/token/associateToken.js itself with Hedera and dotenv
// mocked, and records the associations it sends.

const operatorKey = PrivateKey.generateECDSA();
const buyerKey = PrivateKey.generateECDSA();
const calls = {};

function mockDependencies({ associated = [] } = {}) {
  calls.associated = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({ setOperator: jest.fn().mockReturnThis(), close: calls.close }));
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => {
    const actual = actualSdk();
    const alreadyAssociated = Object.create(actual.ReceiptStatusError.prototype);
    alreadyAssociated.status = actual.Status.TokenAlreadyAssociatedToAccount;
    return {
      ...actual,
      Client: { forTestnet: calls.forTestnet },
      TokenAssociateTransaction: jest.fn().mockImplementation(() => {
        const record = { signed: [] };
        const tx = {
          setAccountId: (id) => ((record.account = id.toString()), tx),
          setTokenIds: (ids) => ((record.tokens = ids.map(String)), tx),
          freezeWith: () => tx,
          sign: async (k) => (record.signed.push(k.publicKey.toString()), tx),
          execute: async () => {
            calls.associated.push(record);
            if (associated.includes(record.tokens[0])) throw alreadyAssociated;
            return { getReceipt: async () => ({ status: Status.Success }) };
          },
        };
        return tx;
      }),
    };
  });
}

async function runScript(...args) {
  process.argv = ["node", "src/token/associateToken.js", ...args];
  const { done } = await import("../src/token/associateToken.js");
  await done;
}

describe("associateToken.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: operatorKey.toStringDer(),
      UMINA_TOKEN_ID: "0.0.2002",
      ACHALA_TOKEN_ID: "0.0.4004",
      BUYER_ID: "0.0.6006",
      BUYER_KEY: buyerKey.toStringDer(),
    });
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

  test("associates the Umiña token by default, signed by the account", async () => {
    mockDependencies();
    await runScript("buyer");

    expect(calls.associated).toEqual([
      { account: "0.0.6006", tokens: ["0.0.2002"], signed: [buyerKey.publicKey.toString()] },
    ]);
    expect(console.log).toHaveBeenCalledWith("✅ buyer 0.0.6006 associated 0.0.2002");
    expect(process.exitCode).toBeUndefined();
  });

  test("--token achala associates both tokens: an Achala moves with its stones (#28)", async () => {
    mockDependencies();
    await runScript("buyer", "--token", "achala");

    expect(calls.associated.map((r) => r.tokens)).toEqual([["0.0.2002"], ["0.0.4004"]]);
    expect(process.exitCode).toBeUndefined();
  });

  test("skips a token already associated and associates the other", async () => {
    mockDependencies({ associated: ["0.0.2002"] });
    await runScript("buyer", "--token", "achala");

    expect(console.log).toHaveBeenCalledWith("ℹ️  buyer 0.0.6006 already associated 0.0.2002");
    expect(console.log).toHaveBeenCalledWith("✅ buyer 0.0.6006 associated 0.0.4004");
    expect(process.exitCode).toBeUndefined();
  });

  test("--dry-run lists both tokens for --token achala and sends nothing", async () => {
    mockDependencies();
    await runScript("buyer", "--token", "achala", "--dry-run");

    expect(console.log).toHaveBeenCalledWith("Would associate 0.0.2002 with buyer 0.0.6006");
    expect(console.log).toHaveBeenCalledWith("Would associate 0.0.4004 with buyer 0.0.6006");
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(calls.associated).toEqual([]);
  });

  test("--token achala needs UMINA_TOKEN_ID too and sends nothing without it", async () => {
    delete process.env.UMINA_TOKEN_ID;
    mockDependencies();
    await runScript("buyer", "--token", "achala");

    expect(console.error).toHaveBeenCalledWith("   - UMINA_TOKEN_ID is not set");
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("an extra argument is refused and nothing is sent", async () => {
    mockDependencies();
    await runScript("buyer", "merchant");

    expect(console.error).toHaveBeenCalledWith("   - too many arguments: merchant");
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
