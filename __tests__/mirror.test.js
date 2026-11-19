import { jest } from "@jest/globals";
import {
  accountKey,
  accountNfts,
  latestArrival,
  mirrorTxId,
  nftInfo,
  normalizeTxId,
  topicEvents,
  topicInfo,
  transactionRecord,
} from "../src/mirror.js";
import { mirrorNode } from "../src/network.js";

const MIRROR_NODE = mirrorNode();

const json = (status, body) =>
  jest.fn().mockResolvedValue({ ok: status === 200, status, json: async () => body, text: async () => "err" });

describe("transaction IDs", () => {
  test("normalizeTxId takes either form and pads the nanoseconds", () => {
    expect(normalizeTxId("0.0.1001@1700000000.5")).toBe("0.0.1001@1700000000.000000005");
    expect(normalizeTxId("0.0.1001-1700000000-000000005")).toBe("0.0.1001@1700000000.000000005");
    expect(normalizeTxId(" 0.0.1001@1700000000.000000005 ")).toBe("0.0.1001@1700000000.000000005");
  });

  test("normalizeTxId returns null for anything else", () => {
    expect(normalizeTxId("0.0.1001")).toBeNull();
    expect(normalizeTxId(undefined)).toBeNull();
  });

  test("mirrorTxId gives the mirror node form", () => {
    expect(mirrorTxId("0.0.1001@1700000000.5")).toBe("0.0.1001-1700000000-000000005");
  });
});

describe("lookups", () => {
  test("transactionRecord asks for the mirror form and returns the parent record", async () => {
    const fetchFn = json(200, {
      transactions: [
        { name: "child", parent_consensus_timestamp: "1.1" },
        { name: "parent" },
      ],
    });
    expect((await transactionRecord("0.0.1001@1700000000.5", fetchFn)).name).toBe("parent");
    expect(fetchFn).toHaveBeenCalledWith(
      `${MIRROR_NODE}/api/v1/transactions/0.0.1001-1700000000-000000005`,
    );
  });

  test("transactionRecord returns null for an unknown transaction and refuses a bad ID", async () => {
    expect(await transactionRecord("0.0.1@1.1", json(404))).toBeNull();
    await expect(transactionRecord("nope", json(200, {}))).rejects.toThrow('not a transaction ID: "nope"');
  });

  test("nftInfo, accountKey and topicInfo return null on 404", async () => {
    expect(await nftInfo("0.0.2002", 7, json(404))).toBeNull();
    expect(await accountKey("0.0.6006", json(404))).toBeNull();
    expect(await topicInfo("0.0.3003", json(404))).toBeNull();
  });

  test("nftInfo and accountKey read the right paths", async () => {
    const nftFetch = json(200, { account_id: "0.0.6006" });
    expect((await nftInfo("0.0.2002", 7, nftFetch)).account_id).toBe("0.0.6006");
    expect(nftFetch).toHaveBeenCalledWith(`${MIRROR_NODE}/api/v1/tokens/0.0.2002/nfts/7`);
    const keyFetch = json(200, { key: { _type: "ED25519", key: "ab" } });
    expect(await accountKey("0.0.6006", keyFetch)).toEqual({ _type: "ED25519", key: "ab" });
    expect(keyFetch).toHaveBeenCalledWith(`${MIRROR_NODE}/api/v1/accounts/0.0.6006`);
  });

  test("reports any other failed request", async () => {
    await expect(nftInfo("0.0.2002", 7, json(500))).rejects.toThrow("mirror node request failed: 500 err");
  });
});

const encode = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");

const topic = { ok: true, status: 200, json: async () => ({ topic_id: "0.0.3003", deleted: false }) };

const page = (messages, next = null) => ({
  ok: true,
  status: 200,
  json: async () => ({ messages, links: { next } }),
});

describe("topicEvents", () => {
  test("follows links.next and returns the JSON events with their sequence numbers", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(
        page(
          [{ sequence_number: 1, message: encode({ event: "MINT" }) }],
          "/api/v1/topics/0.0.3003/messages?limit=100&order=asc&sequencenumber=gt:1",
        ),
      )
      .mockResolvedValueOnce(page([{ sequence_number: 2, message: encode({ event: "SALE" }) }]));

    const events = await topicEvents("0.0.3003", fetchFn);

    expect(events).toEqual([
      { sequence_number: 1, event: { event: "MINT" } },
      { sequence_number: 2, event: { event: "SALE" } },
    ]);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      `${MIRROR_NODE}/api/v1/topics/0.0.3003`,
      `${MIRROR_NODE}/api/v1/topics/0.0.3003/messages?limit=100&order=asc`,
      `${MIRROR_NODE}/api/v1/topics/0.0.3003/messages?limit=100&order=asc&sequencenumber=gt:1`,
    ]);
  });

  test("keeps each message's consensus timestamp when the mirror node gives it", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(
        page([{ sequence_number: 1, consensus_timestamp: "1700000000.000000001", message: encode({ event: "LISTED" }) }]),
      );
    expect(await topicEvents("0.0.3004", fetchFn)).toEqual([
      { sequence_number: 1, consensus_timestamp: "1700000000.000000001", event: { event: "LISTED" } },
    ]);
  });

  test("skips messages that are not JSON objects", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(topic)
      .mockResolvedValueOnce(
        page([
          { sequence_number: 1, message: encode("hello") },
          { sequence_number: 2, message: encode("42") },
          { sequence_number: 3, message: encode({ event: "MINT" }) },
        ]),
      );
    expect(await topicEvents("0.0.3003", fetchFn)).toEqual([
      { sequence_number: 3, event: { event: "MINT" } },
    ]);
  });

  test("returns no events for an empty topic", async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(topic).mockResolvedValueOnce(page([]));
    expect(await topicEvents("0.0.3003", fetchFn)).toEqual([]);
  });

  test("says when the topic does not exist, though its messages answer with an empty list", async () => {
    // What the testnet mirror node really does for a missing topic
    const fetchFn = jest.fn(async (url) =>
      url.endsWith("/topics/0.0.1234") ? { ok: false, status: 404 } : page([]),
    );
    await expect(topicEvents("0.0.1234", fetchFn)).rejects.toThrow(
      "HCS topic 0.0.1234 was not found on the mirror node",
    );
  });

  test("treats a deleted topic as not found", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: true }) });
    await expect(topicEvents("0.0.3003", fetchFn)).rejects.toThrow(
      "HCS topic 0.0.3003 was not found on the mirror node",
    );
  });

  test("reports any other failed request", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: async () => "busy" });
    await expect(topicEvents("0.0.3003", fetchFn)).rejects.toThrow(
      "mirror node request failed: 503 busy",
    );
  });
});

describe("accountNfts and latestArrival (#43)", () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  test("accountNfts follows links.next and leaves out burned NFTs", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(ok({ nfts: [{ serial_number: 1, deleted: false }], links: { next: "/next" } }))
      .mockResolvedValueOnce(
        ok({ nfts: [{ serial_number: 2, deleted: true }, { serial_number: 3, deleted: false }], links: { next: null } }),
      );
    expect((await accountNfts("0.0.1001", "0.0.2002", fetchFn)).map((n) => n.serial_number)).toEqual([1, 3]);
    expect(fetchFn.mock.calls[0][0]).toBe(`${MIRROR_NODE}/api/v1/accounts/0.0.1001/nfts?token.id=0.0.2002&limit=100`);
  });

  test("accountNfts says when the account does not exist", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(accountNfts("0.0.9", "0.0.2002", fetchFn)).rejects.toThrow(
      "account 0.0.9 was not found on the mirror node",
    );
  });

  test("latestArrival is the newest transaction that moved the NFT into the account", async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(
      ok({
        transactions: [
          { consensus_timestamp: "30.0", type: "CRYPTODELETEALLOWANCE", sender_account_id: null, receiver_account_id: null },
          { consensus_timestamp: "20.0", type: "CRYPTOTRANSFER", sender_account_id: "0.0.4004", receiver_account_id: "0.0.1001" },
          { consensus_timestamp: "10.0", type: "TOKENMINT", sender_account_id: null, receiver_account_id: "0.0.1001" },
        ],
        links: { next: null },
      }),
    );
    expect(await latestArrival("0.0.2002", 7, "0.0.1001", fetchFn)).toBe("20.0");
    expect(fetchFn.mock.calls[0][0]).toBe(
      `${MIRROR_NODE}/api/v1/tokens/0.0.2002/nfts/7/transactions?limit=25&order=desc`,
    );
  });

  test("latestArrival follows pages, and is null when nothing arrived or the NFT is unknown", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(ok({ transactions: [{ consensus_timestamp: "5.0", receiver_account_id: "0.0.6006" }], links: { next: "/next" } }))
      .mockResolvedValueOnce(ok({ transactions: [{ consensus_timestamp: "1.0", receiver_account_id: "0.0.1001" }], links: { next: null } }));
    expect(await latestArrival("0.0.2002", 7, "0.0.1001", fetchFn)).toBe("1.0");
    const notFound = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    expect(await latestArrival("0.0.2002", 7, "0.0.1001", notFound)).toBeNull();
    const empty = jest.fn().mockResolvedValue(ok({ transactions: [], links: { next: null } }));
    expect(await latestArrival("0.0.2002", 7, "0.0.1001", empty)).toBeNull();
  });
});
