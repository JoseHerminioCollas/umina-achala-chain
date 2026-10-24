import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";

// Runs src/createUminaToken.js itself (it calls main() on import) with dotenv
// and the network client mocked, and records how it signs and executes.

const key = PrivateKey.generateECDSA().toStringDer();
const calls = {};

function mockDependencies({ executeError } = {}) {
  calls.dotenv = jest.fn();
  calls.signed = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({
    networkName: "testnet",
    setOperator: jest.fn().mockReturnThis(),
    close: calls.close,
  }));

  jest.doMock("dotenv", () => ({
    __esModule: true,
    default: { config: calls.dotenv },
  }));

  jest.doMock("@hashgraph/sdk", () => ({
    ...jest.requireActual("@hashgraph/sdk"),
    Client: { forTestnet: calls.forTestnet },
  }));

  jest.doMock("../src/uminaToken.js", () => {
    const actual = jest.requireActual("../src/uminaToken.js");
    const tx = {
      freezeWith: jest.fn(async () => tx),
      sign: jest.fn(async (k) => calls.signed.push(k.publicKey.toString())),
      execute: jest.fn(async () => {
        if (executeError) throw executeError;
        return { getReceipt: async () => ({ tokenId: "0.0.9999" }) };
      }),
    };
    return { ...actual, buildTokenTransaction: jest.fn(() => tx) };
  });
}

function setEnv(extra = {}) {
  Object.assign(process.env, {
    OPERATOR_ID: "0.0.1001",
    OPERATOR_KEY: key,
    TREASURY_ID: "0.0.1001",
    ADMIN_KEY: key,
    SUPPLY_KEY: key,
    FEE_SCHEDULE_KEY: key,
    PAUSE_KEY: key,
    WIPE_KEY: key,
    ...extra,
  });
}

async function runScript(...args) {
  process.argv = ["node", "src/createUminaToken.js", ...args];
  await import("../src/createUminaToken.js");
  // main() is not awaited by the module, so let its promises settle
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createUminaToken.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  let log;

  beforeEach(() => {
    jest.resetModules();
    setEnv();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...env };
    process.argv = [...argv];
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("loads .env.testnet by default and the given file when one is passed", async () => {
    mockDependencies();
    await runScript("--dry-run");
    expect(calls.dotenv).toHaveBeenCalledWith({ path: ".env.testnet" });

    jest.resetModules();
    mockDependencies();
    await runScript("other.env", "--dry-run");
    expect(calls.dotenv).toHaveBeenCalledWith({ path: "other.env" });
  });

  test("--dry-run prints the parameters and never connects", async () => {
    mockDependencies();
    await runScript("--dry-run");

    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Dry run, nothing sent:");
    expect(process.exitCode).toBeUndefined();
  });

  test("lists the problems and exits non-zero when the environment is wrong", async () => {
    delete process.env.SUPPLY_KEY;
    mockDependencies();
    await runScript();

    expect(console.error).toHaveBeenCalledWith("   - SUPPLY_KEY is missing");
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("signs with the admin key, executes, prints the token id and the env file", async () => {
    mockDependencies();
    await runScript();

    const admin = PrivateKey.fromStringDer(key).publicKey.toString();
    expect(calls.signed).toEqual([admin]);
    expect(log).toHaveBeenCalledWith("✅ Success! Umiña Token ID: 0.0.9999");
    expect(log).toHaveBeenCalledWith(
      "SAVE THIS ID IN .env.testnet AS: UMINA_TOKEN_ID",
    );
    expect(calls.close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("also signs with TREASURY_KEY when the treasury is another account", async () => {
    const treasury = PrivateKey.generateECDSA();
    setEnv({ TREASURY_ID: "0.0.2002", TREASURY_KEY: treasury.toStringDer() });
    mockDependencies();
    await runScript();

    expect(calls.signed).toHaveLength(2);
    expect(calls.signed[1]).toBe(treasury.publicKey.toString());
  });

  test("exits non-zero and still closes the client when execution fails", async () => {
    mockDependencies({ executeError: new Error("INSUFFICIENT_PAYER_BALANCE") });
    await runScript();

    expect(console.error).toHaveBeenCalledWith(
      "❌ Token creation failed:",
      expect.any(Error),
      { operatorId: "0.0.1001", treasuryAccountId: "0.0.1001" },
    );
    expect(calls.close).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
