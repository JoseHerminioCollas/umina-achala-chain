import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";
import { actualSdk } from "../testHelpers/actualSdk.js";

// Runs src/display/displayEvent.js itself (it runs on import) with dotenv,
// the Hedera client, HCS and the mirror node mocked.

const UMINA = "0.0.2002";
const ACHALA = "0.0.2003";
const TREASURY = "0.0.1001";
const PROVENANCE = "0.0.3003";
const DISPLAY = "0.0.3004";
const BUYER = "0.0.6006";
const operatorKey = PrivateKey.generateECDSA();
const submitKey = PrivateKey.generateECDSA();
const calls = {};

const mint = (tokenId, serial, stoneId, extra = {}) => ({
  event: "MINT", token_id: tokenId, serials: [String(serial)], stone_id: stoneId, ...extra,
});
const provenanceEvents = [
  mint(UMINA, 7, "UMINA-2026-AG-01"),
  mint(UMINA, 8, "UMINA-2026-AU-01"),
  mint(ACHALA, 1, "ACHALA-2026-PE-02", { from_stone_ids: ["UMINA-2026-AU-01"] }),
];
const listed = (ts, serial, price, tokenId = UMINA) => ({
  ts, event: { event: "LISTED", token_id: tokenId, serials: [String(serial)], price, currency: "HBAR" },
});

/**
 * display: [{ ts, event }]; nfts: { "token/serial": info | null } (default:
 * held by the Treasury); arrivals: { "token/serial": timestamp } (default "1.0").
 */
function mockDependencies({ display = [], nfts = {}, arrivals = {}, hcsReceiptError } = {}) {
  calls.hcs = null;
  calls.urls = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({ setOperator: jest.fn().mockReturnThis(), close: calls.close }));
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => ({
    ...actualSdk(),
    Client: { forTestnet: calls.forTestnet },
    TopicMessageSubmitTransaction: jest.fn().mockImplementation(() => {
      const tx = {
        setTopicId: (id) => ((calls.hcs = { topicId: id, signed: [] }), tx),
        setMessage: (m) => ((calls.hcs.message = JSON.parse(m)), tx),
        freezeWith: () => tx,
        sign: async (k) => (calls.hcs.signed.push(k.publicKey.toString()), tx),
        execute: async () => ({
          transactionId: { toString: () => "0.0.1001@1700000009.000000009" },
          getReceipt: async () => {
            if (hcsReceiptError) throw hcsReceiptError;
            return { status: "SUCCESS" };
          },
        }),
      };
      return tx;
    }),
  }));
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => "" });
  const messages = (list) =>
    reply(200, {
      messages: list.map((m, i) => ({
        sequence_number: i + 1,
        ...(m.ts && { consensus_timestamp: m.ts }),
        // display entries are { ts, event }; provenance entries are the events themselves
        message: Buffer.from(JSON.stringify(m.ts ? m.event : m)).toString("base64"),
      })),
      links: { next: null },
    });
  const holder = (key) => (key in nfts ? nfts[key] : { account_id: TREASURY, deleted: false });
  global.fetch = jest.fn(async (url) => {
    calls.urls.push(url);
    const p = url.replace("https://testnet.mirrornode.hedera.com", "");
    let m;
    if ((m = /^\/api\/v1\/topics\/([\d.]+)\/messages/.exec(p))) {
      return messages(m[1] === DISPLAY ? display : provenanceEvents);
    }
    if (/^\/api\/v1\/topics\/[\d.]+$/.test(p)) return reply(200, { deleted: false });
    if ((m = /^\/api\/v1\/tokens\/([\d.]+)\/nfts\/(\d+)\/transactions/.exec(p))) {
      const ts = arrivals[`${m[1]}/${m[2]}`] ?? "1.0";
      return reply(200, {
        transactions: [
          { consensus_timestamp: "999.0", sender_account_id: null, receiver_account_id: null },
          { consensus_timestamp: ts, sender_account_id: BUYER, receiver_account_id: TREASURY },
        ],
        links: { next: null },
      });
    }
    if ((m = /^\/api\/v1\/tokens\/([\d.]+)\/nfts\/(\d+)$/.exec(p))) {
      const info = holder(`${m[1]}/${m[2]}`);
      return info ? reply(200, info) : reply(404);
    }
    if ((m = /^\/api\/v1\/accounts\/([\d.]+)\/nfts\?token\.id=([\d.]+)/.exec(p))) {
      const serials = { [UMINA]: [8, 7], [ACHALA]: [1] }[m[2]] ?? [];
      return reply(200, {
        nfts: serials.map((s) => ({ serial_number: s, account_id: TREASURY, deleted: false })),
        links: { next: null },
      });
    }
    return reply(404);
  });
}

async function run(...args) {
  process.argv = ["node", "src/display/displayEvent.js", ...args];
  await import("../src/display/displayEvent.js");
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

const errors = () => console.error.mock.calls.map((c) => c.join(" ")).join("\n");

describe("displayEvent.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  const fetchBefore = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: TREASURY,
      OPERATOR_KEY: operatorKey.toStringDer(),
      TREASURY_ID: TREASURY,
      UMINA_TOKEN_ID: UMINA,
      ACHALA_TOKEN_ID: ACHALA,
      HCS_TOPIC_ID: PROVENANCE,
      HCS_DISPLAY_TOPIC_ID: DISPLAY,
      HCS_SUBMIT_KEY: submitKey.toStringDer(),
    });
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "table").mockImplementation(() => {});
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

  describe("listed", () => {
    test("records LISTED on the display topic, with the stone_id from the MINT", async () => {
      mockDependencies();
      await run("listed", "7", "--price", "50.50");

      expect(process.exitCode).toBeUndefined();
      expect(calls.hcs.topicId).toBe(DISPLAY);
      expect(calls.hcs.signed).toEqual([submitKey.publicKey.toString()]);
      expect(calls.hcs.message).toEqual({
        event: "LISTED",
        schema_version: 1,
        stone_id: "UMINA-2026-AG-01",
        token_id: UMINA,
        serials: ["7"],
        actor_id: TREASURY,
        occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
        price: "50.5",
        currency: "HBAR",
      });
      expect(calls.close).toHaveBeenCalled();
    });

    test("lists an Achala as one item", async () => {
      mockDependencies();
      await run("listed", "1", "--price", "120", "--token", "achala");
      expect(calls.hcs.message).toMatchObject({ event: "LISTED", stone_id: "ACHALA-2026-PE-02", token_id: ACHALA, serials: ["1"] });
    });

    test("a new price is a new LISTED", async () => {
      mockDependencies({ display: [listed("5.0", 7, "50")] });
      await run("listed", "7", "--price", "60");
      expect(calls.hcs.message).toMatchObject({ event: "LISTED", price: "60" });
    });

    test("--dry-run checks and sends nothing", async () => {
      mockDependencies();
      await run("listed", "7", "--price", "50", "--dry-run");
      expect(process.exitCode).toBeUndefined();
      expect(calls.hcs).toBeNull();
      expect(calls.forTestnet).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent.");
    });

    test("refuses the same price again", async () => {
      mockDependencies({ display: [listed("5.0", 7, "50")] });
      await run("listed", "7", "--price", "50.00");
      expect(process.exitCode).toBe(1);
      expect(calls.hcs).toBeNull();
      expect(errors()).toMatch(/already listed at 50 HBAR \(display event #1\)/);
    });

    test("an item sold and returned is listed again, its old LISTED does not count", async () => {
      // listed at 5.0, sold, back in the Treasury at 8.0
      mockDependencies({ display: [listed("5.0", 7, "50")], arrivals: { [`${UMINA}/7`]: "8.0" } });
      await run("listed", "7", "--price", "50");
      expect(process.exitCode).toBeUndefined();
      expect(calls.hcs.message).toMatchObject({ event: "LISTED", price: "50" });
    });

    test("refuses a stone mounted in an Achala", async () => {
      mockDependencies();
      await run("listed", "8", "--price", "10");
      expect(process.exitCode).toBe(1);
      expect(calls.hcs).toBeNull();
      expect(errors()).toMatch(/UMINA-2026-AU-01 .* is mounted in Achala ACHALA-2026-PE-02/);
    });

    test("refuses an item the Treasury does not hold, or a burned one", async () => {
      mockDependencies({ nfts: { [`${UMINA}/7`]: { account_id: BUYER, deleted: false } } });
      await run("listed", "7", "--price", "10");
      expect(process.exitCode).toBe(1);
      expect(errors()).toMatch(/is held by 0\.0\.6006, not the Treasury 0\.0\.1001\. Only items the Treasury holds are listed\./);

      jest.resetModules();
      process.exitCode = undefined;
      mockDependencies({ nfts: { [`${UMINA}/7`]: { account_id: TREASURY, deleted: true } } });
      await run("listed", "7", "--price", "10");
      expect(process.exitCode).toBe(1);
      expect(errors()).toMatch(/is burned/);
    });

    test("refuses a serial with no MINT, before reading the holder", async () => {
      mockDependencies();
      await run("listed", "99", "--price", "10");
      expect(process.exitCode).toBe(1);
      expect(errors()).toMatch(/0\.0\.2002\/99 has no MINT on the provenance topic/);
      expect(calls.urls.some((u) => u.includes("/nfts/99"))).toBe(false);
    });
  });

  describe("unlisted", () => {
    test("records UNLISTED with its reason", async () => {
      mockDependencies({ display: [listed("5.0", 7, "50")] });
      await run("unlisted", "7", "--reason", "Photo retake");
      expect(calls.hcs.topicId).toBe(DISPLAY);
      expect(calls.hcs.message).toMatchObject({ event: "UNLISTED", stone_id: "UMINA-2026-AG-01", serials: ["7"], reason: "Photo retake" });
      expect(calls.hcs.message.price).toBeUndefined();
    });

    test("refuses an item that is not listed", async () => {
      mockDependencies({ display: [listed("5.0", 7, "50"), { ts: "6.0", event: { event: "UNLISTED", token_id: UMINA, serials: ["7"] } }] });
      await run("unlisted", "7");
      expect(process.exitCode).toBe(1);
      expect(errors()).toMatch(/it is not listed now, so there is nothing to unlist/);
    });

    test("can unlist a stone listed before it was mounted", async () => {
      mockDependencies({ display: [listed("5.0", 8, "10")] });
      await run("unlisted", "8");
      expect(process.exitCode).toBeUndefined();
      expect(calls.hcs.message).toMatchObject({ event: "UNLISTED", serials: ["8"] });
    });
  });

  describe("status", () => {
    test("shows every Treasury item with its listing, and sends nothing", async () => {
      mockDependencies({ display: [listed("5.0", 7, "50"), listed("5.5", 8, "10"), listed("6.0", 1, "120", ACHALA)] });
      await run("status");
      expect(process.exitCode).toBeUndefined();
      expect(calls.hcs).toBeNull();
      expect(calls.forTestnet).not.toHaveBeenCalled();
      expect(console.table).toHaveBeenCalledWith([
        { token: "Umiña", serial: 7, stone_id: "UMINA-2026-AG-01", state: "listed, 50 HBAR" },
        { token: "Umiña", serial: 8, stone_id: "UMINA-2026-AU-01", state: "in Achala ACHALA-2026-PE-02 (still listed, 10 HBAR: unlist it)" },
        { token: "Achala", serial: 1, stone_id: "ACHALA-2026-PE-02", state: "listed, 120 HBAR" },
      ]);
      expect(console.log).toHaveBeenCalledWith("2 of 3 items held by the Treasury 0.0.1001 are listed.");
    });

    test("needs no operator key", async () => {
      delete process.env.OPERATOR_KEY;
      mockDependencies();
      await run("status", "--token", "achala");
      expect(process.exitCode).toBeUndefined();
      expect(console.table).toHaveBeenCalledWith([
        { token: "Achala", serial: 1, stone_id: "ACHALA-2026-PE-02", state: "not listed" },
      ]);
    });
  });

  test("argument and environment problems stop it before any request", async () => {
    delete process.env.HCS_DISPLAY_TOPIC_ID;
    mockDependencies();
    await run("listed", "7", "--price", "0");
    expect(process.exitCode).toBe(1);
    expect(calls.urls).toEqual([]);
    expect(errors()).toMatch(/--price must be a positive amount/);
  });

  test("a failed HCS receipt is reported as a failure", async () => {
    mockDependencies({ hcsReceiptError: new Error("INVALID_SIGNATURE") });
    await run("listed", "7", "--price", "50");
    expect(process.exitCode).toBe(1);
    expect(errors()).toMatch(/Display event failed/);
  });
});
