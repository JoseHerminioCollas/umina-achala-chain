import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { PrivateKey } from "@hashgraph/sdk";

// Runs src/record/recordEvent.js itself (it calls main() on import) with
// dotenv, the Hedera client, HCS and the mirror node mocked.

const TOKEN = "0.0.2002";
const SELLER = "0.0.4004";
const BUYER = "0.0.6006";
const NFT_TX = "0.0.6006@1700000000.000000001";
const operatorKey = PrivateKey.generateECDSA();
const buyerKey = PrivateKey.generateECDSA();
const calls = {};

const nftMove = { token_id: TOKEN, serial_number: 7, sender_account_id: SELLER, receiver_account_id: BUYER };
const atomicSale = {
  result: "SUCCESS",
  consensus_timestamp: "1700000000.500000000",
  transaction_id: "0.0.6006-1700000000-000000001",
  charged_tx_fee: 0,
  nft_transfers: [nftMove],
  transfers: [
    { account: BUYER, amount: -10_000_000_000 },
    { account: SELLER, amount: 10_000_000_000 },
  ],
};

// mirror: { events, transactions: { mirrorTxId: record }, nft, key }
function mockDependencies({ events = [], transactions = {}, nft, key, hcsReceiptError } = {}) {
  calls.hcs = null;
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({ setOperator: jest.fn().mockReturnThis(), close: calls.close }));
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => ({
    ...jest.requireActual("@hashgraph/sdk"),
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
  global.fetch = jest.fn(async (url) => {
    const p = url.replace("https://testnet.mirrornode.hedera.com", "");
    if (p.startsWith("/api/v1/topics/")) {
      return reply(200, {
        messages: events.map((event, i) => ({
          sequence_number: i + 1,
          message: Buffer.from(JSON.stringify(event)).toString("base64"),
        })),
        links: { next: null },
      });
    }
    if (p.startsWith("/api/v1/transactions/")) {
      const record = transactions[p.split("/").pop()];
      return record ? reply(200, { transactions: [record] }) : reply(404);
    }
    if (p.startsWith(`/api/v1/tokens/${TOKEN}/nfts/`)) return nft ? reply(200, nft) : reply(404);
    if (p.startsWith("/api/v1/accounts/")) return key ? reply(200, { key }) : reply(404);
    return reply(404);
  });
}

async function runScript(...args) {
  process.argv = ["node", "src/record/recordEvent.js", ...args];
  await import("../src/record/recordEvent.js");
  // main() is not awaited by the module; let its promises settle
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const sale = (...extra) => [
  "sale", "7", "--seller", SELLER, "--buyer", BUYER, "--nft-tx", NFT_TX, ...extra,
];
const recordedSale = {
  event: "SALE", token_id: TOKEN, serials: ["7"], buyer_id: BUYER, ref: NFT_TX,
};

describe("recordEvent.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  const fetchBefore = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: operatorKey.toStringDer(),
      UMINA_TOKEN_ID: TOKEN,
      HCS_TOPIC_ID: "0.0.3003",
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
    global.fetch = fetchBefore;
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  describe("sale", () => {
    test("records an on_chain sale the ledger confirms, timed at the NFT transfer", async () => {
      mockDependencies({ transactions: { "0.0.6006-1700000000-000000001": atomicSale } });
      await runScript(...sale("--payment", "on_chain", "--sold-for", "100", "--stone-id", "UMINA-2026-CH-03"));

      expect(calls.hcs.topicId).toBe("0.0.3003");
      expect(calls.hcs.message).toEqual({
        event: "SALE",
        schema_version: 1,
        stone_id: "UMINA-2026-CH-03",
        token_id: TOKEN,
        serials: ["7"],
        actor_id: "0.0.1001",
        occurred_at: "2023-11-14T22:13:20Z",
        ref: NFT_TX,
        seller_id: SELLER,
        buyer_id: BUYER,
        payment: "on_chain",
        sold_for: "100",
        currency: "HBAR",
      });
      expect(process.exitCode).toBeUndefined();
      expect(calls.close).toHaveBeenCalled();
    });

    test("records a wallet-to-wallet sale with the separate payment as payment_ref", async () => {
      const payment = {
        result: "SUCCESS",
        transaction_id: "0.0.6006-1700000001-000000002",
        charged_tx_fee: 0,
        transfers: [
          { account: BUYER, amount: -5_000_000_000 },
          { account: SELLER, amount: 5_000_000_000 },
        ],
      };
      mockDependencies({
        transactions: {
          "0.0.6006-1700000000-000000001": { ...atomicSale, transfers: [] },
          "0.0.6006-1700000001-000000002": payment,
        },
      });
      await runScript(...sale("--payment", "on_chain", "--payment-tx", "0.0.6006-1700000001-2", "--sold-for", "50"));

      expect(calls.hcs.message).toMatchObject({
        ref: NFT_TX,
        payment_ref: "0.0.6006@1700000001.000000002",
        sold_for: "50",
      });
    });

    test("records an off_chain sale with the price as stated", async () => {
      mockDependencies({ transactions: { "0.0.6006-1700000000-000000001": { ...atomicSale, transfers: [] } } });
      await runScript(...sale("--payment", "off_chain", "--sold-for", "350", "--currency", "PEN"));

      expect(calls.hcs.message).toMatchObject({ payment: "off_chain", sold_for: "350", currency: "PEN" });
    });

    test("refuses a sale already recorded for the same transaction", async () => {
      mockDependencies({
        events: [{ ...recordedSale, ref: "0.0.6006@1700000000.1" }],
        transactions: { "0.0.6006-1700000000-000000001": atomicSale },
      });
      await runScript(...sale("--payment", "on_chain"));

      expect(console.error).toHaveBeenCalledWith(
        `   - a SALE for ${NFT_TX} is already recorded (event #1)`,
      );
      expect(calls.hcs).toBeNull();
      expect(process.exitCode).toBe(1);
    });

    test("refuses a sale the ledger does not confirm, and sends nothing", async () => {
      mockDependencies({ transactions: { "0.0.6006-1700000000-000000001": atomicSale } });
      await runScript(...sale("--payment", "on_chain", "--sold-for", "90"));

      expect(console.error).toHaveBeenCalledWith(
        `   - ${BUYER} paid 10000000000 tinybars in --nft-tx ${NFT_TX}, but --sold-for is 9000000000 tinybars`,
      );
      expect(calls.hcs).toBeNull();
      expect(calls.forTestnet).not.toHaveBeenCalled();
    });

    test("--dry-run does the checks, prints the event and sends nothing", async () => {
      mockDependencies({ transactions: { "0.0.6006-1700000000-000000001": atomicSale } });
      await runScript(...sale("--payment", "on_chain", "--dry-run"));

      expect(console.log).toHaveBeenCalledWith("✅ The ledger agrees. SALE event:");
      expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent.");
      expect(calls.forTestnet).not.toHaveBeenCalled();
      expect(calls.hcs).toBeNull();
    });
  });

  describe("delivered", () => {
    const held = { account_id: BUYER, deleted: false };
    const buyerKeyInfo = { _type: "ECDSA_SECP256K1", key: buyerKey.publicKey.toStringRaw() };

    function writeProof(key = buyerKey, serial = "7") {
      const message = `Umiña Achala delivery: account ${BUYER} received token ${TOKEN} serial ${serial}.`;
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proof-")), "proof.json");
      const signature = Buffer.from(key.sign(Buffer.from(message))).toString("hex");
      fs.writeFileSync(file, JSON.stringify({ message, signature }));
      return file;
    }

    test("records a delivery without proof as proof none, referring to the sale", async () => {
      mockDependencies({ events: [recordedSale], nft: held });
      await runScript("delivered", "7", "--buyer", BUYER, "--delivered-at", "2026-11-05T15:00:00Z");

      expect(calls.hcs.message).toEqual({
        event: "DELIVERED",
        schema_version: 1,
        token_id: TOKEN,
        serials: ["7"],
        actor_id: "0.0.1001",
        occurred_at: "2026-11-05T15:00:00Z",
        ref: NFT_TX,
        buyer_id: BUYER,
        method: "in_person",
        delivered_at: "2026-11-05T15:00:00Z",
        proof: "none",
      });
      expect(process.exitCode).toBeUndefined();
    });

    test("records a signed proof's hash after checking it against the buyer's key", async () => {
      mockDependencies({ events: [recordedSale], nft: held, key: buyerKeyInfo });
      await runScript("delivered", "7", "--buyer", BUYER, "--proof", writeProof());

      expect(calls.hcs.message).toMatchObject({ proof: "signed", proof_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    });

    test("refuses a proof that does not check out, and says how to record without it", async () => {
      mockDependencies({ events: [recordedSale], nft: held, key: buyerKeyInfo });
      await runScript("delivered", "7", "--buyer", BUYER, "--proof", writeProof(PrivateKey.generateECDSA()));

      expect(console.error).toHaveBeenCalledWith(
        '   - the proof signature does not match the buyer\'s account key. Fix the proof, or leave out --proof to record the delivery with proof "none".',
      );
      expect(calls.hcs).toBeNull();
      expect(process.exitCode).toBe(1);
    });

    test("refuses when the buyer does not hold the NFT", async () => {
      mockDependencies({ events: [recordedSale], nft: { account_id: SELLER, deleted: false } });
      await runScript("delivered", "7", "--buyer", BUYER);

      expect(console.error).toHaveBeenCalledWith(
        `   - ${TOKEN} serial 7 is held by ${SELLER}, not the buyer ${BUYER}`,
      );
      expect(calls.hcs).toBeNull();
    });

    test("refuses when no sale to the buyer is recorded", async () => {
      mockDependencies({ events: [], nft: held });
      await runScript("delivered", "7", "--buyer", BUYER);

      expect(console.error).toHaveBeenCalledWith(
        `   - no SALE of serial 7 to ${BUYER} is recorded; record it first with "recordEvent.js sale"`,
      );
    });

    test("refuses a second delivery for the same sale", async () => {
      mockDependencies({
        events: [recordedSale, { event: "DELIVERED", token_id: TOKEN, serials: ["7"], buyer_id: BUYER, ref: NFT_TX }],
        nft: held,
      });
      await runScript("delivered", "7", "--buyer", BUYER);

      expect(console.error).toHaveBeenCalledWith(
        `   - a DELIVERED for the sale ${NFT_TX} is already recorded (event #2)`,
      );
      expect(calls.hcs).toBeNull();
    });

    test("--dry-run prints the message the buyer should sign", async () => {
      mockDependencies({ events: [recordedSale], nft: held });
      await runScript("delivered", "7", "--buyer", BUYER, "--dry-run");

      expect(console.log).toHaveBeenCalledWith(
        `Delivery message for the buyer to sign: "Umiña Achala delivery: account ${BUYER} received token ${TOKEN} serial 7."`,
      );
      expect(calls.hcs).toBeNull();
    });
  });

  test("signs with HCS_SUBMIT_KEY when it is set", async () => {
    const submitKey = PrivateKey.generateECDSA();
    process.env.HCS_SUBMIT_KEY = submitKey.toStringDer();
    mockDependencies({ transactions: { "0.0.6006-1700000000-000000001": atomicSale } });
    await runScript(...sale("--payment", "on_chain"));

    expect(calls.hcs.signed).toEqual([submitKey.publicKey.toString()]);
  });

  test("reports an event rejected at consensus", async () => {
    mockDependencies({
      transactions: { "0.0.6006-1700000000-000000001": atomicSale },
      hcsReceiptError: new Error("INVALID_SIGNATURE"),
    });
    await runScript(...sale("--payment", "on_chain"));

    expect(console.error).toHaveBeenCalledWith("❌ Recording failed:", expect.objectContaining({ message: "INVALID_SIGNATURE" }));
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("stops when the topic cannot be read", async () => {
    mockDependencies();
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => "" }));
    await runScript(...sale("--payment", "on_chain"));

    expect(console.error).toHaveBeenCalledWith(
      "   - cannot read HCS_TOPIC_ID 0.0.3003: HCS topic 0.0.3003 was not found on the mirror node",
    );
    expect(process.exitCode).toBe(1);
  });

  test("lists argument and environment problems together, before reading anything", async () => {
    delete process.env.HCS_TOPIC_ID;
    mockDependencies();
    await runScript("sale", "7");

    expect(console.error).toHaveBeenCalledWith("   - --buyer is required");
    expect(console.error).toHaveBeenCalledWith("   - HCS_TOPIC_ID is not set");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
