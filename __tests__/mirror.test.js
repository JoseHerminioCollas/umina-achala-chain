import { jest } from "@jest/globals";
import { MIRROR_NODE, topicEvents } from "../src/mirror.js";

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
