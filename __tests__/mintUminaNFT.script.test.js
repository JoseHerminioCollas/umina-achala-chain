import { jest } from "@jest/globals";

// Runs src/mintUminaNFT.js itself (it calls main() on import) with Hedera,
// IPFS and dotenv mocked, and records what it sends.

const calls = { mint: null, hcs: null, pinned: null, order: [] };

function mockDependencies({ validatorResult } = {}) {
  jest.doMock("dotenv", () => ({
    __esModule: true,
    default: { config: jest.fn() },
  }));

  jest.doMock("@hashgraph/sdk", () => ({
    Client: {
      forTestnet: () => ({ setOperator: jest.fn().mockReturnThis() }),
      forMainnet: () => ({ setOperator: jest.fn().mockReturnThis() }),
    },
    PrivateKey: { fromStringECDSA: jest.fn(() => "mock-key") },
    TopicMessageSubmitTransaction: jest.fn().mockImplementation(() => {
      const tx = {
        setTopicId: jest.fn((id) => ((calls.hcs = { topicId: id }), tx)),
        setMessage: jest.fn((m) => ((calls.hcs.message = JSON.parse(m)), tx)),
        execute: jest.fn(async () => {
          calls.order.push("hcs");
          return { transactionId: { toString: () => "0.0.1@1700000000.1" } };
        }),
      };
      return tx;
    }),
    TokenMintTransaction: jest.fn().mockImplementation(() => {
      const tx = {
        setTokenId: jest.fn((id) => ((calls.mint = { tokenId: id }), tx)),
        setMetadata: jest.fn((m) => ((calls.mint.metadata = m), tx)),
        execute: jest.fn(async () => {
          calls.order.push("mint");
          return { getReceipt: async () => ({ serials: [7] }) };
        }),
      };
      return tx;
    }),
  }));

  jest.doMock("ipfs-http-client", () => ({
    create: jest.fn(() => ({
      add: jest.fn(async (json) => {
        calls.order.push("pin");
        calls.pinned = JSON.parse(json);
        return { cid: { toString: () => "QmMockCID12345" } };
      }),
    })),
  }));

  if (validatorResult) {
    jest.doMock("../src/metadataValidator.js", () => ({
      validateMetadata: () => validatorResult,
    }));
  }
}

async function runScript() {
  await import("../src/mintUminaNFT.js");
  // main() is not awaited by the module, so let its promises settle
  await new Promise((resolve) => setImmediate(resolve));
}

describe("mintUminaNFT.js", () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    calls.mint = calls.hcs = calls.pinned = null;
    calls.order = [];
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: "mock-key",
      UMINA_TOKEN_ID: "0.0.2002",
      HCS_TOPIC_ID: "0.0.3003",
    });
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "table").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...env };
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("mints under UMINA_TOKEN_ID with the pinned ipfs:// URI as metadata", async () => {
    mockDependencies();
    await runScript();

    expect(calls.mint.tokenId).toBe("0.0.2002");
    expect(calls.mint.metadata).toHaveLength(1);
    expect(calls.mint.metadata[0].toString()).toBe("ipfs://QmMockCID12345");
  });

  test("submits a MINT message to HCS_TOPIC_ID with stone_id and actor_id", async () => {
    mockDependencies();
    await runScript();

    expect(calls.hcs.topicId).toBe("0.0.3003");
    expect(calls.hcs.message).toEqual({
      event: "MINT",
      stone_id: calls.pinned.stone_id,
      actor_id: "0.0.1001",
    });
  });

  test("pins metadata that carries the timestamp, stone_id and HCS proof", async () => {
    mockDependencies();
    await runScript();

    expect(calls.pinned.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(calls.pinned.stone_id).toBe(
      `${calls.pinned.stone_type}-${calls.pinned.timestamp}`,
    );
    expect(calls.pinned.compliance_proof_hcs).toBe("0.0.1@1700000000.1");
  });

  test("does not touch HCS, IPFS or the token when validation fails", async () => {
    mockDependencies({
      validatorResult: { valid: false, errors: [{ message: "bad" }] },
    });
    await runScript();

    expect(calls.order).toEqual([]);
    expect(calls.mint).toBeNull();
  });

  // Known gaps, tracked in umina-achala-chain#3. test.failing passes while the
  // script is wrong and fails once it is fixed, which is the cue to make these
  // normal tests.
  test.failing("notarizes in HCS after the mint succeeds", async () => {
    mockDependencies();
    await runScript();

    expect(calls.order).toEqual(["pin", "mint", "hcs"]);
  });

  test.failing("exits non-zero when the workflow fails", async () => {
    mockDependencies({
      validatorResult: { valid: false, errors: [{ message: "bad" }] },
    });
    await runScript();

    expect(process.exitCode).toBe(1);
  });
});
