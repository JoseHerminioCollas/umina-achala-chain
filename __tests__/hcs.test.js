import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";
import {
  buildEvent,
  loadSubmitKey,
  MAX_MESSAGE_BYTES,
  SCHEMA_VERSION,
  submitKeyProblem,
  utcSeconds,
} from "../src/hcs.js";
import { actualSdk } from "../testHelpers/actualSdk.js";

const envelope = {
  event: "MINT",
  stoneId: "UMINA-2026-CH-03",
  tokenId: "0.0.2002",
  serials: [7],
  actorId: "0.0.1001",
  occurredAt: new Date("2026-10-27T15:00:00.123Z"),
  ref: "0.0.1001@1700000000.0",
};

describe("buildEvent", () => {
  test("puts the envelope fields first, then the event fields", () => {
    const message = buildEvent(envelope, { ipfs_cid: "QmCID" });
    expect(message).toEqual({
      event: "MINT",
      schema_version: SCHEMA_VERSION,
      stone_id: "UMINA-2026-CH-03",
      token_id: "0.0.2002",
      serials: ["7"],
      actor_id: "0.0.1001",
      occurred_at: "2026-10-27T15:00:00Z",
      ref: "0.0.1001@1700000000.0",
      ipfs_cid: "QmCID",
    });
    expect(Object.keys(message).slice(0, 2)).toEqual(["event", "schema_version"]);
  });

  test("leaves out stone_id and ref when they are not given", () => {
    const { stoneId, ref, ...rest } = envelope;
    const message = buildEvent(rest);
    expect(message).not.toHaveProperty("stone_id");
    expect(message).not.toHaveProperty("ref");
  });

  test("takes SDK ids and writes them as strings", () => {
    const message = buildEvent({
      ...envelope,
      tokenId: { toString: () => "0.0.2002" },
      actorId: { toString: () => "0.0.1001" },
    });
    expect(message.token_id).toBe("0.0.2002");
    expect(message.actor_id).toBe("0.0.1001");
  });

  test("defaults occurred_at to now, to the second", () => {
    const { occurredAt, ...rest } = envelope;
    const before = utcSeconds(new Date());
    const message = buildEvent(rest);
    expect(message.occurred_at >= before).toBe(true);
    expect(message.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test("refuses a message over the HCS size limit", () => {
    const big = { note: "x".repeat(MAX_MESSAGE_BYTES) };
    expect(() => buildEvent(envelope, big)).toThrow(/over the 1024-byte HCS limit/);
  });
});

describe("submit key", () => {
  test("is optional", () => {
    expect(submitKeyProblem({})).toBeNull();
    expect(loadSubmitKey({})).toBeNull();
  });

  test("is parsed when set", () => {
    const key = PrivateKey.generateECDSA();
    const env = { HCS_SUBMIT_KEY: key.toStringDer() };
    expect(submitKeyProblem(env)).toBeNull();
    expect(loadSubmitKey(env).publicKey.toString()).toBe(key.publicKey.toString());
  });

  test("names a key that is not ECDSA", () => {
    const ed = PrivateKey.generateED25519().toStringDer();
    expect(submitKeyProblem({ HCS_SUBMIT_KEY: ed })).toBe(
      "HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    );
  });
});

describe("submitEvent", () => {
  let calls;

  async function loadWithMock({ executeError, receiptError } = {}) {
    calls = { order: [], signed: [] };
    jest.resetModules();
    jest.doMock("@hashgraph/sdk", () => ({
      ...actualSdk(),
      TopicMessageSubmitTransaction: jest.fn().mockImplementation(() => {
        const tx = {
          setTopicId: jest.fn((id) => ((calls.topicId = id), tx)),
          setMessage: jest.fn((m) => ((calls.message = JSON.parse(m)), tx)),
          freezeWith: jest.fn(() => (calls.order.push("freeze"), tx)),
          sign: jest.fn(async (k) => {
            calls.order.push("sign");
            calls.signed.push(k.publicKey.toString());
            return tx;
          }),
          execute: jest.fn(async () => {
            calls.order.push("execute");
            if (executeError) throw executeError;
            return {
              transactionId: { toString: () => "0.0.1@1700000000.1" },
              getReceipt: jest.fn(async () => {
                calls.order.push("receipt");
                if (receiptError) throw receiptError;
                return { status: "SUCCESS" };
              }),
            };
          }),
        };
        return tx;
      }),
    }));
    return import("../src/hcs.js");
  }

  afterEach(() => jest.dontMock("@hashgraph/sdk"));

  test("waits for the receipt and returns the transaction ID", async () => {
    const { submitEvent } = await loadWithMock();
    const id = await submitEvent({}, "0.0.3003", { event: "MINT" });
    expect(id).toBe("0.0.1@1700000000.1");
    expect(calls.topicId).toBe("0.0.3003");
    expect(calls.message).toEqual({ event: "MINT" });
    expect(calls.order).toEqual(["freeze", "execute", "receipt"]);
  });

  test("signs with the submit key before executing", async () => {
    const { submitEvent } = await loadWithMock();
    const key = PrivateKey.generateECDSA();
    await submitEvent({}, "0.0.3003", { event: "MINT" }, key);
    expect(calls.order).toEqual(["freeze", "sign", "execute", "receipt"]);
    expect(calls.signed).toEqual([key.publicKey.toString()]);
  });

  test("throws when the message is rejected at consensus", async () => {
    const { submitEvent } = await loadWithMock({
      receiptError: new Error("INVALID_SIGNATURE"),
    });
    await expect(submitEvent({}, "0.0.3003", { event: "MINT" })).rejects.toThrow(
      "INVALID_SIGNATURE",
    );
  });

  test("throws when a node rejects the message", async () => {
    const { submitEvent } = await loadWithMock({ executeError: new Error("INVALID_TOPIC_ID") });
    await expect(submitEvent({}, "0.0.3003", { event: "MINT" })).rejects.toThrow(
      "INVALID_TOPIC_ID",
    );
  });
});
