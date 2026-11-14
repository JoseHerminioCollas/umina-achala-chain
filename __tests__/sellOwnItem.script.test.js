import { jest } from "@jest/globals";
import { mockMirror, restoreMirror } from "../testHelpers/mockMirror.js";
import { PrivateKey } from "@hashgraph/sdk";
import { saleProblems } from "../src/sale/lib.js";
import { actualSdk } from "../testHelpers/actualSdk.js";

// Runs src/sale/sellOwnItem.js itself (it calls main() on import) with Hedera
// and dotenv mocked, and records what it sends.

const operatorKey = PrivateKey.generateECDSA();
const buyerKey = PrivateKey.generateECDSA();
const treasuryKey = PrivateKey.generateECDSA();
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

function mockDependencies({ holder = "0.0.1001", saleError, hcsReceiptError, topicEvents = [] } = {}) {
  calls.mirror = mockMirror(topicEvents, { holder });
  calls.steps = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({ setOperator: jest.fn().mockReturnThis(), close: calls.close }));
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => ({
    ...actualSdk(),
    Client: { forTestnet: calls.forTestnet },
    TransferTransaction: mockTransaction("sale", {
      executeError: saleError,
      txId: "0.0.1001@1700000000.7",
    }),
    TopicMessageSubmitTransaction: mockTransaction("hcs", {
      receiptError: hcsReceiptError,
      txId: "0.0.1001@1700000000.8",
    }),
  }));
}

async function runScript(...args) {
  process.argv = ["node", "src/sale/sellOwnItem.js", ...args];
  await import("../src/sale/sellOwnItem.js");
  await new Promise((resolve) => setImmediate(resolve));
}

const step = (name) => calls.steps.find((s) => s.name === name);
const callsTo = (record, method) => record.calls.filter(([m]) => m === method).map(([, ...a]) => a);
const hbarMoves = (record) =>
  callsTo(record, "addHbarTransfer").map(([account, hbar]) => [
    account.toString(),
    hbar.toTinybars().toString(),
  ]);

const baseEnv = () => ({
  OPERATOR_ID: "0.0.1001",
  OPERATOR_KEY: operatorKey.toStringDer(),
  TREASURY_ID: "0.0.1001",
  UMINA_TOKEN_ID: "0.0.2002",
  HCS_TOPIC_ID: "0.0.3003",
  BUYER_ID: "0.0.6006",
  BUYER_KEY: buyerKey.toStringDer(),
});

describe("saleProblems", () => {
  test("no problems with every variable set, a serial and a price", () => {
    expect(saleProblems(baseEnv(), "7", "100")).toEqual([]);
    expect(saleProblems(baseEnv(), "7", "0.5")).toEqual([]);
  });

  test("lists missing variables, a bad serial and a bad price", () => {
    const env = baseEnv();
    delete env.BUYER_KEY;
    expect(saleProblems(env, "0", "-1")).toEqual([
      "BUYER_KEY is not set",
      "give the NFT serial number as a positive integer",
      "give the price in HBAR as a positive number, at most 8 decimals",
    ]);
  });

  test("rejects a price with more than 8 decimals", () => {
    expect(saleProblems(baseEnv(), "7", "1.123456789")).toEqual([
      "give the price in HBAR as a positive number, at most 8 decimals",
    ]);
  });

  test("requires TREASURY_KEY only when the treasury is another account", () => {
    expect(saleProblems({ ...baseEnv(), TREASURY_ID: "0.0.5005" }, "7", "100")).toEqual([
      "TREASURY_KEY is required when TREASURY_ID is not OPERATOR_ID",
    ]);
  });

  test("an Achala sale needs ACHALA_TOKEN_ID, and UMINA_TOKEN_ID for its stones", () => {
    const env = baseEnv();
    delete env.UMINA_TOKEN_ID;
    expect(saleProblems(env, "1", "100", "achala")).toEqual([
      "UMINA_TOKEN_ID is not set",
      "ACHALA_TOKEN_ID is not set",
    ]);
  });

  test("rejects an HCS_SUBMIT_KEY that is not an ECDSA key", () => {
    expect(saleProblems({ ...baseEnv(), HCS_SUBMIT_KEY: "x" }, "7", "100")).toEqual([
      "HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    ]);
  });
});

describe("sellOwnItem.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, baseEnv());
    delete process.env.TREASURY_KEY;
    delete process.env.HCS_SUBMIT_KEY;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "table").mockImplementation(() => {});
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

  test("sells from the Treasury in one transaction: the price to UA, the NFT to the buyer", async () => {
    mockDependencies();
    await runScript("7", "100");

    expect(calls.steps.map((s) => s.name)).toEqual(["sale", "hcs"]);
    const sale = step("sale");
    expect(hbarMoves(sale)).toEqual([
      ["0.0.6006", "-10000000000"],
      ["0.0.1001", "10000000000"],
    ]);
    const [[nftId, from, to]] = callsTo(sale, "addNftTransfer");
    expect([nftId.toString(), from.toString(), to.toString()]).toEqual([
      "0.0.2002/7",
      "0.0.1001",
      "0.0.6006",
    ]);
    expect(callsTo(sale, "addApprovedNftTransfer")).toEqual([]);
    expect(sale.signed).toEqual([pub(buyerKey)]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test("also signs with TREASURY_KEY when the treasury is another account", async () => {
    process.env.TREASURY_ID = "0.0.5005";
    process.env.TREASURY_KEY = treasuryKey.toStringDer();
    mockDependencies({ holder: "0.0.5005" });
    await runScript("7", "100");

    const sale = step("sale");
    expect(callsTo(sale, "addNftTransfer")[0][1].toString()).toBe("0.0.5005");
    expect(sale.signed).toEqual([pub(buyerKey), pub(treasuryKey)]);
  });

  test("records a SALE event with the Treasury as seller and the sale as ref", async () => {
    mockDependencies();
    await runScript("7", "12.5");

    const message = JSON.parse(callsTo(step("hcs"), "setMessage")[0][0]);
    expect(message).toEqual({
      event: "SALE",
      schema_version: 1,
      token_id: "0.0.2002",
      serials: ["7"],
      actor_id: "0.0.1001",
      occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      ref: "0.0.1001@1700000000.7",
      seller_id: "0.0.1001",
      buyer_id: "0.0.6006",
      payment: "on_chain",
      sold_for: "12.5",
      currency: "HBAR",
      price_tinybars: "1250000000",
    });
    expect(callsTo(step("hcs"), "setTopicId")).toEqual([["0.0.3003"]]);
  });

  test("signs the SALE event with HCS_SUBMIT_KEY when it is set", async () => {
    const submitKey = PrivateKey.generateECDSA();
    process.env.HCS_SUBMIT_KEY = submitKey.toStringDer();
    mockDependencies();
    await runScript("7", "100");

    expect(step("hcs").signed).toEqual([pub(submitKey)]);
  });

  test("sells nothing when the Treasury no longer holds the serial", async () => {
    mockDependencies({ holder: "0.0.7007" });
    await runScript("7", "100");

    expect(calls.mirror).toContain("https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.2002/nfts/7");
    expect(console.error).toHaveBeenCalledWith(
      "   - 0.0.2002/7 is held by 0.0.7007, not the Treasury 0.0.1001. Remove the listing.",
    );
    expect(calls.steps).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("does not record a SALE when the sale fails", async () => {
    mockDependencies({ saleError: new Error("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT") });
    await runScript("7", "100");

    expect(calls.steps.map((s) => s.name)).toEqual(["sale"]);
    expect(console.error).toHaveBeenCalledWith("❌ Sale failed:", expect.any(Error));
    expect(process.exitCode).toBe(1);
  });

  test("says the sale settled when the SALE event is rejected at consensus", async () => {
    mockDependencies({ hcsReceiptError: new Error("INVALID_SIGNATURE") });
    await runScript("7", "100");

    expect(console.error).toHaveBeenCalledWith(
      "❌ Sale 0.0.1001@1700000000.7 settled but the HCS record failed:",
      expect.objectContaining({ message: "INVALID_SIGNATURE" }),
    );
    expect(process.exitCode).toBe(1);
  });

  test("lists the problems and sends nothing", async () => {
    mockDependencies();
    await runScript("7");

    expect(console.error).toHaveBeenCalledWith(
      "   - give the price in HBAR as a positive number, at most 8 decimals",
    );
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run shows the sale and sends nothing", async () => {
    mockDependencies();
    await runScript("7", "100", "--dry-run");

    expect(console.table).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent.");
    expect(calls.forTestnet).not.toHaveBeenCalled();
  });

  // --- An Achala and mounted stones (umina-achala-chain#24, #26) ---

  const topic = [
    { event: "MINT", stone_id: "UMINA-2026-CH-03", token_id: "0.0.2002", serials: ["3"] },
    { event: "MINT", stone_id: "UMINA-2026-AU-01", token_id: "0.0.2002", serials: ["4"] },
    {
      event: "MINT",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.4004",
      serials: ["1"],
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
    },
  ];

  test("reads the provenance topic before selling, also on --dry-run", async () => {
    mockDependencies();
    await runScript("7", "100", "--dry-run");

    expect(calls.mirror).toEqual([
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3003",
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3003/messages?limit=100&order=asc",
    ]);
  });

  test.each([[[]], [["--dry-run"]]])("refuses an Umiña mounted in an Achala, and sends nothing %j", async (extra) => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ topicEvents: topic });
    await runScript("3", "100", ...extra);

    expect(console.error).toHaveBeenCalledWith(
      "   - UMINA-2026-CH-03 (0.0.2002/3) is mounted in Achala ACHALA-2026-RI-01 (0.0.4004/1, MINT #3): " +
        "it moves only with its Achala, and is freed when the Achala is burned",
    );
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("sells an Umiña whose Achala was burned", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ topicEvents: [...topic, { event: "BURN", token_id: "0.0.4004", serials: ["1"] }] });
    await runScript("3", "100");

    expect(calls.steps.map((s) => s.name)).toEqual(["sale", "hcs"]);
    expect(process.exitCode).toBeUndefined();
  });

  test("--token achala sells the Achala with its stones in one transfer and records one SALE", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ topicEvents: topic });
    await runScript("1", "500", "--token", "achala");

    const sale = step("sale");
    expect(callsTo(sale, "addNftTransfer").map(([id, from, to]) => [id.toString(), from.toString(), to.toString()])).toEqual([
      ["0.0.4004/1", "0.0.1001", "0.0.6006"],
      ["0.0.2002/3", "0.0.1001", "0.0.6006"],
      ["0.0.2002/4", "0.0.1001", "0.0.6006"],
    ]);
    expect(hbarMoves(sale)).toEqual([
      ["0.0.6006", "-50000000000"],
      ["0.0.1001", "50000000000"],
    ]);
    expect(callsTo(sale, "setTransactionMemo")).toEqual([["Achala sale 0.0.4004/1"]]);
    expect(JSON.parse(callsTo(step("hcs"), "setMessage")[0][0])).toMatchObject({
      event: "SALE",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.4004",
      serials: ["1"],
      ref: "0.0.1001@1700000000.7",
      seller_id: "0.0.1001",
      buyer_id: "0.0.6006",
      sold_for: "500",
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
      umina_token_id: "0.0.2002",
      umina_serials: ["3", "4"],
    });
    expect(process.exitCode).toBeUndefined();
  });

  test("--token achala sells nothing when the Treasury no longer holds one of the NFTs", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ topicEvents: topic, holder: "0.0.7007" });
    await runScript("1", "500", "--token", "achala");

    expect(console.error).toHaveBeenCalledWith(
      "   - 0.0.4004/1 is held by 0.0.7007, not the Treasury 0.0.1001. Remove the listing.",
    );
    expect(calls.steps).toEqual([]);
  });

  test("--token achala refuses a burned Achala", async () => {
    process.env.ACHALA_TOKEN_ID = "0.0.4004";
    mockDependencies({ topicEvents: [...topic, { event: "BURN", token_id: "0.0.4004", serials: ["1"] }] });
    await runScript("1", "500", "--token", "achala", "--dry-run");

    expect(console.error).toHaveBeenCalledWith("   - Achala 0.0.4004/1 is burned (the piece was taken apart)");
    expect(process.exitCode).toBe(1);
  });

  test("refuses an unknown --token", async () => {
    mockDependencies();
    await runScript("1", "500", "--token", "ring");

    expect(console.error).toHaveBeenCalledWith('   - --token must be umina or achala, got "ring"');
    expect(calls.mirror).toEqual([]);
  });
});
