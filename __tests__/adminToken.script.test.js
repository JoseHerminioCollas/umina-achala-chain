import { jest } from "@jest/globals";
import { mockMirror, restoreMirror } from "../testHelpers/mockMirror.js";
import { PrivateKey, Status } from "@hashgraph/sdk";

// Runs src/token/adminToken.js itself (it calls main() on import) with
// Hedera and dotenv mocked, and records what it sends.

const keys = {
  operator: PrivateKey.generateECDSA(),
  feeSchedule: PrivateKey.generateECDSA(),
  pause: PrivateKey.generateECDSA(),
  wipe: PrivateKey.generateECDSA(),
  supply: PrivateKey.generateECDSA(),
};
const pub = (k) => k.publicKey.toString();
const calls = {};

// A mock transaction: method calls are recorded with their raw arguments;
// sign records the key; execute records the step.
function mockTransaction(name, { executeError, receiptError } = {}) {
  return jest.fn().mockImplementation(() => {
    const record = { name, calls: {}, signed: [] };
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
                transactionId: { toString: () => `0.0.1001@1700000000.${name}` },
                getReceipt: async () => {
                  if (receiptError) throw receiptError;
                  return { status: Status.Success };
                },
              };
            };
          return (...a) => ((record.calls[prop] = a), tx);
        },
      },
    );
    return tx;
  });
}

function mockDependencies({ holder = "0.0.6006", hcsReceiptError, topicEvents = [] } = {}) {
  calls.mirror = mockMirror(topicEvents);
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
    TokenFeeScheduleUpdateTransaction: mockTransaction("fees"),
    TokenPauseTransaction: mockTransaction("pause"),
    TokenUnpauseTransaction: mockTransaction("unpause"),
    TokenWipeTransaction: mockTransaction("wipe"),
    TokenBurnTransaction: mockTransaction("burn"),
    TopicMessageSubmitTransaction: mockTransaction("hcs", { receiptError: hcsReceiptError }),
  }));
}

async function runScript(...args) {
  process.argv = ["node", "src/token/adminToken.js", ...args];
  await import("../src/token/adminToken.js");
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

const step = (name) => calls.steps.find((s) => s.name === name);
const event = () => JSON.parse(step("hcs").calls.setMessage[0]);

describe("adminToken.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: keys.operator.toStringDer(),
      UMINA_TOKEN_ID: "0.0.2002",
      TREASURY_ID: "0.0.1001",
      HCS_TOPIC_ID: "0.0.3003",
      FEE_SCHEDULE_KEY: keys.feeSchedule.toStringDer(),
      PAUSE_KEY: keys.pause.toStringDer(),
      WIPE_KEY: keys.wipe.toStringDer(),
      SUPPLY_KEY: keys.supply.toStringDer(),
    });
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

  test("fees replaces the custom fees, signed by the fee schedule key, and records nothing", async () => {
    mockDependencies();
    await runScript("fees", "--fallback-hbar", "41", "--royalty", "6");

    expect(calls.steps.map((s) => s.name)).toEqual(["fees"]);
    const [fee] = step("fees").calls.setCustomFees[0];
    expect(fee.numerator.toNumber()).toBe(6);
    expect(fee.feeCollectorAccountId.toString()).toBe("0.0.1001");
    expect(fee.fallbackFee.hbarAmount.toTinybars().toString()).toBe("4100000000");
    expect(step("fees").calls.setTokenId[0].toString()).toBe("0.0.2002");
    expect(step("fees").signed).toEqual([pub(keys.feeSchedule)]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test.each([
    ["pause", "pause"],
    ["unpause", "pause"],
  ])("%s is signed by the pause key and records nothing", async (command) => {
    mockDependencies();
    await runScript(command);

    expect(calls.steps.map((s) => s.name)).toEqual([command]);
    expect(step(command).signed).toEqual([pub(keys.pause)]);
  });

  test("wipe checks the holder, wipes with the wipe key and records BURN with the reason", async () => {
    mockDependencies({ holder: "0.0.6006" });
    await runScript("wipe", "7", "--account", "0.0.6006", "--reason", "Stolen; police report 2026-123");

    expect(calls.infoFor).toBe("0.0.2002/7");
    expect(step("wipe").calls.setAccountId).toEqual(["0.0.6006"]);
    expect(step("wipe").calls.setSerials).toEqual([[7]]);
    expect(step("wipe").signed).toEqual([pub(keys.wipe)]);
    expect(event()).toEqual({
      event: "BURN",
      schema_version: 1,
      token_id: "0.0.2002",
      serials: ["7"],
      actor_id: "0.0.1001",
      occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      ref: "0.0.1001@1700000000.wipe",
      reason: "Stolen; police report 2026-123",
      method: "wipe",
      from_id: "0.0.6006",
    });
  });

  test("burn checks the serial is in the treasury and records BURN", async () => {
    mockDependencies({ holder: "0.0.1001" });
    await runScript("burn", "7", "--reason", "Re-mint with corrected metadata");

    expect(step("burn").calls.setSerials).toEqual([[7]]);
    expect(step("burn").signed).toEqual([pub(keys.supply)]);
    expect(event()).toMatchObject({ event: "BURN", reason: "Re-mint with corrected metadata", method: "burn" });
    expect(event()).not.toHaveProperty("from_id");
  });

  test("refuses to burn a serial that is not in the treasury", async () => {
    mockDependencies({ holder: "0.0.6006" });
    await runScript("burn", "7", "--reason", "x");

    expect(console.error).toHaveBeenCalledWith("   - 0.0.2002/7 is held by 0.0.6006, not the treasury 0.0.1001");
    expect(calls.steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("refuses to wipe from an account that does not hold the serial", async () => {
    mockDependencies({ holder: "0.0.7007" });
    await runScript("wipe", "7", "--account", "0.0.6006", "--reason", "x");

    expect(console.error).toHaveBeenCalledWith("   - 0.0.2002/7 is held by 0.0.7007, not --account 0.0.6006");
    expect(calls.steps).toEqual([]);
  });

  test("says the burn happened when BURN is rejected at consensus", async () => {
    mockDependencies({ holder: "0.0.1001", hcsReceiptError: new Error("INVALID_SIGNATURE") });
    await runScript("burn", "7", "--reason", "x");

    expect(console.error).toHaveBeenCalledWith(
      "   The burn already happened in 0.0.1001@1700000000.burn, but BURN was not recorded.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("signs BURN with HCS_SUBMIT_KEY when it is set", async () => {
    const submitKey = PrivateKey.generateECDSA();
    process.env.HCS_SUBMIT_KEY = submitKey.toStringDer();
    mockDependencies({ holder: "0.0.1001" });
    await runScript("burn", "7", "--reason", "x");

    expect(step("hcs").signed).toEqual([pub(submitKey)]);
  });

  test("--dry-run says what it would do and sends nothing", async () => {
    mockDependencies();
    await runScript("fees", "--fallback-hbar", "38", "--dry-run");

    expect(console.log).toHaveBeenCalledWith(
      "Would set the fees of 0.0.2002: 5% royalty to 0.0.1001, fallback fee 38 HBAR, signed by FEE_SCHEDULE_KEY.",
    );
    expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent.");
    expect(calls.forTestnet).not.toHaveBeenCalled();
  });

  test("--token achala burns an Achala NFT (a disassembled piece) and records BURN under that token", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ holder: "0.0.1001" });
    await runScript("burn", "3", "--reason", "Piece disassembled", "--token", "achala");

    expect(calls.infoFor).toBe("0.0.4004/3");
    expect(step("burn").calls.setTokenId[0].toString()).toBe("0.0.4004");
    expect(event()).toMatchObject({ event: "BURN", token_id: "0.0.4004", serials: ["3"], reason: "Piece disassembled" });
  });

  test("lists problems and sends nothing", async () => {
    delete process.env.WIPE_KEY;
    mockDependencies();
    await runScript("wipe", "7", "--account", "0.0.6006", "--reason", "x");

    expect(console.error).toHaveBeenCalledWith("   - WIPE_KEY is not set");
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // --- Mounted stones (umina-achala-chain#24) ---
  const mountedTopic = (achala) => [
    { event: "MINT", stone_id: "UMINA-2026-CH-07", token_id: "0.0.2002", serials: ["7"] },
    { event: "MINT", stone_id: "ACHALA-2026-RI-01", token_id: achala, serials: ["1"], from_stone_ids: ["UMINA-2026-CH-07"] },
  ];

  test.each([
    ["burn", ["burn", "7", "--reason", "x"]],
    ["wipe", ["wipe", "7", "--account", "0.0.6006", "--reason", "x"]],
    ["burn --dry-run", ["burn", "7", "--reason", "x", "--dry-run"]],
  ])("%s refuses an Umiña mounted in an Achala, and sends nothing", async (_, args) => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ topicEvents: mountedTopic("0.0.4004") });
    await runScript(...args);

    expect(console.error).toHaveBeenCalledWith(
      "   - UMINA-2026-CH-07 (0.0.2002/7) is mounted in Achala ACHALA-2026-RI-01 (0.0.4004/1, MINT #2): " +
        "it moves only with its Achala, and is freed when the Achala is burned; burn the Achala first (--token achala)",
    );
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("burning an Achala reads no topic: it is how its stones are freed", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ holder: "0.0.1001", topicEvents: mountedTopic("0.0.4004") });
    await runScript("burn", "1", "--reason", "Piece disassembled", "--token", "achala");

    expect(calls.mirror).toEqual([]);
    expect(step("burn")).toBeDefined();
  });

  test("pause reads no topic", async () => {
    mockDependencies();
    await runScript("pause");

    expect(calls.mirror).toEqual([]);
  });
});
