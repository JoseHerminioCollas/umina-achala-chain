import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";

// Runs src/topic/createTopic.js itself (it calls main() on import) with
// dotenv, the Hedera client, the transaction and the mirror node mocked.

const operatorKey = PrivateKey.generateECDSA();
const adminKey = PrivateKey.generateECDSA();
const submitKey = PrivateKey.generateECDSA();
const calls = {};

function mockDependencies({ executeError, mirrorStatus = 404, mirrorBody = {} } = {}) {
  calls.signed = [];
  calls.executed = false;
  calls.dotenv = jest.fn();
  calls.close = jest.fn();
  calls.mirror = [];
  calls.forTestnet = jest.fn(() => ({
    setOperator: jest.fn().mockReturnThis(),
    close: calls.close,
  }));

  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: calls.dotenv } }));
  jest.doMock("@hashgraph/sdk", () => ({
    ...jest.requireActual("@hashgraph/sdk"),
    Client: { forTestnet: calls.forTestnet },
  }));
  jest.doMock("../src/topic/lib.js", () => {
    const actual = jest.requireActual("../src/topic/lib.js");
    const tx = {
      freezeWith: jest.fn(async () => tx),
      sign: jest.fn(async (k) => calls.signed.push(k.publicKey.toString())),
      execute: jest.fn(async () => {
        calls.executed = true;
        if (executeError) throw executeError;
        return { getReceipt: async () => ({ topicId: "0.0.9999" }) };
      }),
    };
    return {
      ...actual,
      buildTopicTransaction: jest.fn((env, kind) => {
        calls.built = kind;
        return tx;
      }),
    };
  });
  global.fetch = jest.fn(async (url) => {
    calls.mirror.push(url);
    return {
      ok: mirrorStatus === 200,
      status: mirrorStatus,
      json: async () => mirrorBody,
      text: async () => "",
    };
  });
}

async function runScript(...args) {
  process.argv = ["node", "src/topic/createTopic.js", ...args];
  await import("../src/topic/createTopic.js");
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createTopic.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  const fetchBefore = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: operatorKey.toStringDer(),
      HCS_SUBMIT_KEY: submitKey.toStringDer(),
      HCS_ADMIN_KEY: adminKey.toStringDer(),
      HCS_TOPIC_ID: "0.0.1234",
    });
    delete process.env.HCS_DISPLAY_TOPIC_ID;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...env };
    process.argv = [...argv];
    global.fetch = fetchBefore;
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("creates the provenance topic signed by the admin key and says where to save the ID", async () => {
    mockDependencies();
    await runScript("provenance");

    expect(calls.dotenv).toHaveBeenCalledWith({ path: ".env.testnet" });
    expect(calls.built).toBe("provenance");
    expect(calls.signed).toEqual([adminKey.publicKey.toString()]);
    expect(calls.executed).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      "✅ Success! Umiña Achala provenance topic ID: 0.0.9999",
    );
    expect(console.log).toHaveBeenCalledWith("SAVE THIS ID IN .env.testnet AS: HCS_TOPIC_ID");
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test("checks the current HCS_TOPIC_ID on the mirror node first; a placeholder does not block", async () => {
    mockDependencies({ mirrorStatus: 404 });
    await runScript("provenance");

    expect(calls.mirror).toEqual([
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.1234",
    ]);
    expect(calls.executed).toBe(true);
  });

  test("refuses when the variable already names an existing topic", async () => {
    mockDependencies({ mirrorStatus: 200, mirrorBody: { deleted: false, memo: "Umiña Achala provenance" } });
    await runScript("provenance");

    expect(console.error).toHaveBeenCalledWith(
      '❌ HCS_TOPIC_ID already names topic 0.0.1234 ("Umiña Achala provenance"). Use --force to create a new one anyway.',
    );
    expect(calls.executed).toBe(false);
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("--force creates a new topic without checking the existing one", async () => {
    mockDependencies({ mirrorStatus: 200, mirrorBody: { deleted: false, memo: "x" } });
    await runScript("provenance", "--force");

    expect(calls.mirror).toEqual([]);
    expect(calls.executed).toBe(true);
  });

  test("the display topic is saved as HCS_DISPLAY_TOPIC_ID", async () => {
    mockDependencies();
    await runScript("display");

    expect(calls.built).toBe("display");
    expect(console.log).toHaveBeenCalledWith(
      "SAVE THIS ID IN .env.testnet AS: HCS_DISPLAY_TOPIC_ID",
    );
  });

  test("requires the topic kind and sends nothing", async () => {
    mockDependencies();
    await runScript();

    expect(console.error).toHaveBeenCalledWith("   - give the topic kind: provenance or display");
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("lists missing keys and sends nothing", async () => {
    delete process.env.HCS_ADMIN_KEY;
    mockDependencies();
    await runScript("provenance");

    expect(console.error).toHaveBeenCalledWith("   - HCS_ADMIN_KEY is not set");
    expect(calls.executed).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run prints the parameters and touches neither Hedera nor the mirror node", async () => {
    mockDependencies();
    await runScript("provenance", "--dry-run");

    expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent:");
    expect(calls.mirror).toEqual([]);
    expect(calls.forTestnet).not.toHaveBeenCalled();
  });

  test("takes another testnet env file", async () => {
    mockDependencies();
    await runScript("provenance", ".env.testnet.local", "--dry-run");

    expect(calls.dotenv).toHaveBeenCalledWith({ path: ".env.testnet.local" });
  });

  test("refuses an env file that is not for testnet", async () => {
    mockDependencies();
    await runScript("provenance", ".env.mainnet");

    expect(calls.dotenv).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "   - .env.mainnet is not a testnet env file (NETWORK is testnet)",
    );
    expect(process.exitCode).toBe(1);
  });

  test("reports a failed creation and closes the client", async () => {
    mockDependencies({ executeError: new Error("INVALID_SIGNATURE") });
    await runScript("provenance");

    expect(console.error).toHaveBeenCalledWith("❌ Topic creation failed:", expect.any(Error));
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });
});
