import { jest } from "@jest/globals";
import fs from "fs";
import {
  achalaStonesProblem,
  catalogDocument,
  catalogEnvProblems,
  catalogItem,
  catalogProblems,
  isoSeconds,
  itemEvents,
  lastSeq,
  listingSince,
  metadataCache,
  sortNfts,
} from "../src/catalog/lib.js";
import { cidOfNftMetadata, cidOfUri, fetchIpfsBytes, fetchIpfsJson, ipfsGateway, ipfsPathOfUri, NotJsonError } from "../src/ipfs.js";
import { tokenNfts } from "../src/mirror.js";

// The catalog builder's rules (umina-achala-chain#44), the gateway reader and
// the mirror node's token NFT list.

const UMINA = "0.0.2002";
const ACHALA = "0.0.2003";
const TREASURY = "0.0.1001";
const BUYER = "0.0.6006";
const env = {
  UMINA_TOKEN_ID: UMINA,
  ACHALA_TOKEN_ID: ACHALA,
  HCS_TOPIC_ID: "0.0.3003",
  HCS_DISPLAY_TOPIC_ID: "0.0.3004",
  TREASURY_ID: TREASURY,
};

const entry = (sequence_number, event, consensus_timestamp = `${sequence_number}.0`) => ({
  sequence_number,
  consensus_timestamp,
  event,
});
const mint = (seq, tokenId, serial, stoneId, extra = {}) =>
  entry(seq, { event: "MINT", token_id: tokenId, serials: [String(serial)], stone_id: stoneId, ...extra });
const compliance = (seq, stoneId) => entry(seq, { event: "COMPLIANCE", token_id: UMINA, serials: [], stone_id: stoneId });
const listed = (seq, tokenId, serial, price) =>
  entry(seq, { event: "LISTED", token_id: tokenId, serials: [String(serial)], price, currency: "HBAR" });
const unlisted = (seq, tokenId, serial) => entry(seq, { event: "UNLISTED", token_id: tokenId, serials: [String(serial)] });
const nft = (serial, account_id = TREASURY, extra = {}) => ({
  serial_number: serial,
  account_id,
  deleted: false,
  metadata: Buffer.from(`ipfs://Qm${serial}cid`).toString("base64"),
  ...extra,
});

describe("sortNfts", () => {
  const provenance = [
    mint(1, UMINA, 1, "UMINA-2026-AG-01"),
    mint(2, UMINA, 2, "UMINA-2026-AU-01"),
    mint(3, ACHALA, 1, "ACHALA-2026-PE-02", { from_stone_ids: ["UMINA-2026-AU-01"] }),
    mint(4, UMINA, 3, "UMINA-2026-OP-01"),
    mint(5, UMINA, 4, "UMINA-2026-OP-02"),
  ];
  const display = [listed(1, UMINA, 1, "45"), listed(2, ACHALA, 1, "120"), listed(3, UMINA, 2, "10"), listed(4, UMINA, 3, "9"), unlisted(5, UMINA, 3)];

  test("a listed NFT the Treasury holds is a candidate, with its metadata CID and MINT", () => {
    const { candidates } = sortNfts({ env, nfts: { umina: [nft(1)], achala: [] }, provenance, display });
    expect(candidates).toEqual([
      { kind: "umina", token_id: UMINA, serial: 1, stone_id: "UMINA-2026-AG-01", cid: "Qm1cid", mint: provenance[0] },
    ]);
  });

  test("leaves out each other case with its reason, in kind and serial order", () => {
    const nfts = {
      umina: [nft(5), nft(4), nft(3), nft(2), nft(1, BUYER), nft(6, null, { deleted: true })],
      achala: [nft(1)],
    };
    const { candidates, leftOut } = sortNfts({ env, nfts, provenance, display });
    expect(candidates.map((c) => `${c.kind}/${c.serial}`)).toEqual(["achala/1"]);
    expect(leftOut.map(({ serial, reason }) => [serial, reason])).toEqual([
      [1, `held by ${BUYER}`],
      [2, "mounted in ACHALA-2026-PE-02, sold with it"],
      [3, "not listed"],
      [4, "not listed"],
      [5, "no MINT on the provenance topic"],
    ]);
  });

  test("a stone is free again once its Achala is burned", () => {
    const burned = [...provenance, entry(6, { event: "BURN", token_id: ACHALA, serials: ["1"] })];
    const { candidates } = sortNfts({ env, nfts: { umina: [nft(2)], achala: [] }, provenance: burned, display });
    expect(candidates.map((c) => c.stone_id)).toEqual(["UMINA-2026-AU-01"]);
  });

  test("on-chain metadata that is not an ipfs:// URI gives a null CID", () => {
    const odd = nft(1, TREASURY, { metadata: Buffer.from("https://example.com/1.json").toString("base64") });
    expect(sortNfts({ env, nfts: { umina: [odd], achala: [] }, provenance, display }).candidates[0].cid).toBeNull();
  });
});

describe("listingSince", () => {
  const display = [listed(1, UMINA, 7, "50"), listed(3, UMINA, 7, "45")];

  test("gives the latest LISTED as the catalog's price", () => {
    expect(listingSince(display, UMINA, 7, null)).toEqual({
      amount: "45",
      currency: "HBAR",
      listed_seq: 3,
      listed_at: "3.0",
    });
  });

  test("an item sold and returned is not listed by its old LISTED", () => {
    expect(listingSince(display, UMINA, 7, "4.0")).toBeNull();
    expect(listingSince([...display, listed(5, UMINA, 7, "40")], UMINA, 7, "4.0").amount).toBe("40");
  });

  test("UNLISTED after LISTED is not listed", () => {
    expect(listingSince([...display, unlisted(4, UMINA, 7)], UMINA, 7, null)).toBeNull();
  });
});

describe("itemEvents", () => {
  const provenance = [
    compliance(1, "UMINA-2026-AG-01"),
    mint(2, UMINA, 3, "UMINA-2026-AG-01"),
    entry(3, { event: "BURN", token_id: UMINA, serials: ["3"] }),
    compliance(4, "UMINA-2026-AG-01"),
    mint(5, UMINA, 15, "UMINA-2026-AG-01"),
    mint(6, UMINA, 16, "UMINA-2026-CH-01"),
    mint(7, ACHALA, 2, "ACHALA-2026-PE-01", { from_stone_ids: ["UMINA-2026-AG-01"] }),
    entry(8, {
      event: "SALE", token_id: ACHALA, serials: ["2"], umina_token_id: UMINA, umina_serials: ["15"],
    }),
  ];

  test("an NFT's own events, its Achala's events and the COMPLIANCE just before its MINT", () => {
    expect(itemEvents(provenance, UMINA, 15, provenance[4]).map((e) => e.seq)).toEqual([4, 5, 7, 8]);
  });

  test("a stone_id minted again: the old serial keeps its own history", () => {
    expect(itemEvents(provenance, UMINA, 3, provenance[1]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("each event has seq, consensus_timestamp (null when missing) and the event", () => {
    const noTs = [{ sequence_number: 1, event: provenance[1].event }];
    expect(itemEvents(noTs, UMINA, 3, noTs[0])).toEqual([{ seq: 1, consensus_timestamp: null, event: provenance[1].event }]);
  });
});

describe("achalaStonesProblem", () => {
  const metadata = { properties: { stones: [{ serial: 8, stone_id: "UMINA-2026-AU-01" }] } };

  test("null when the Treasury holds every stone", () => {
    expect(achalaStonesProblem(metadata, [nft(8)], TREASURY)).toBeNull();
  });

  test("a stone burned, missing or held by someone else", () => {
    expect(achalaStonesProblem(metadata, [nft(8, null, { deleted: true })], TREASURY)).toMatch(/burned or missing/);
    expect(achalaStonesProblem(metadata, [], TREASURY)).toMatch(/burned or missing/);
    expect(achalaStonesProblem(metadata, [nft(8, BUYER)], TREASURY)).toBe(
      `its stone UMINA-2026-AU-01 (serial 8) is held by ${BUYER}`,
    );
  });
});

describe("metadataCache", () => {
  const previous = {
    schema_version: 1,
    network: "testnet",
    items: [
      { metadata_cid: "QmA", metadata: { a: 1 } },
      { metadata_cid: "QmB", metadata: { b: 1 }, stones: [{ metadata_cid: "QmC", metadata: { c: 1 } }] },
    ],
  };

  test("every item's and stone's metadata by CID", () => {
    expect([...metadataCache(previous, "testnet").keys()]).toEqual(["QmA", "QmB", "QmC"]);
  });

  test("empty for another network, another schema version or no catalog", () => {
    expect(metadataCache(previous, "mainnet").size).toBe(0);
    expect(metadataCache({ ...previous, schema_version: 2 }, "testnet").size).toBe(0);
    expect(metadataCache(null, "testnet").size).toBe(0);
  });
});

describe("the catalog document", () => {
  const umina = JSON.parse(fs.readFileSync("json/umina-example.json", "utf8"));
  const price = { amount: "45", currency: "HBAR", listed_seq: 3, listed_at: "3.0" };
  const ev = [{ seq: 2, consensus_timestamp: "2.0", event: { event: "MINT" } }];
  const nftOf = (stone_id, token_id, serial) => ({ stone_id, token_id, serial, cid: `Qm${serial}`, metadata: umina, events: ev });
  const stone = { stone_id: "UMINA-2026-AU-01", token_id: UMINA, serial: 8, metadata_cid: "Qm8", metadata: umina, events: ev };
  const source = {
    mirror: "https://testnet.mirrornode.hedera.com",
    ipfs_gateway: "https://gateway.pinata.cloud/ipfs/",
    umina_token_id: UMINA,
    achala_token_id: ACHALA,
    provenance_topic: "0.0.3003",
    display_topic: "0.0.3004",
    treasury_id: TREASURY,
    provenance_seq: 70,
    display_seq: 5,
  };
  const doc = () =>
    catalogDocument({
      network: "testnet",
      builtAt: "2026-11-20T15:00:00Z",
      source,
      items: [
        catalogItem(nftOf("ACHALA-2026-PE-02", ACHALA, 5), { kind: "achala", price, stones: [stone] }),
        catalogItem(nftOf("UMINA-2026-AG-02", UMINA, 18), { kind: "umina", price }),
        catalogItem(nftOf("UMINA-2026-AG-01", UMINA, 15), { kind: "umina", price, stones: [stone] }),
      ],
    });

  test("items sorted by kind, then serial; only an Achala has stones", () => {
    const { items } = doc();
    expect(items.map((i) => `${i.kind}/${i.serial}`)).toEqual(["umina/15", "umina/18", "achala/5"]);
    expect(items.map((i) => "stones" in i)).toEqual([false, false, true]);
  });

  test("keys in a fixed order", () => {
    const catalog = doc();
    expect(Object.keys(catalog)).toEqual(["schema_version", "network", "built_at", "source", "items", "media"]);
    expect(Object.keys(catalog.items[2])).toEqual([
      "kind", "stone_id", "token_id", "serial", "metadata_cid", "metadata", "events", "price", "stones",
    ]);
  });

  test("matches schema/catalog-schema.json", () => {
    expect(catalogProblems(doc())).toEqual([]);
    expect(catalogProblems({ ...doc(), items: [] })).toEqual([]);
  });

  test("the schema refuses an Achala without stones, a stone with a price, a bad price or an extra key", () => {
    const bad = (change) => {
      const catalog = doc();
      change(catalog);
      return catalogProblems(catalog);
    };
    expect(bad((c) => delete c.items[2].stones)).not.toEqual([]);
    expect(bad((c) => (c.items[2].stones[0].price = price))).not.toEqual([]);
    expect(bad((c) => (c.items[0].price.amount = "1e3"))).not.toEqual([]);
    expect(bad((c) => (c.items[0].extra = 1))).not.toEqual([]);
    expect(bad((c) => (c.source.treasury_id = "treasury"))).not.toEqual([]);
  });

  test("lastSeq and isoSeconds", () => {
    expect(lastSeq([entry(4, {}), entry(9, {})])).toBe(9);
    expect(lastSeq([])).toBe(0);
    expect(isoSeconds(new Date("2026-11-20T15:00:00.123Z"))).toBe("2026-11-20T15:00:00Z");
  });

  test("catalogEnvProblems needs the tokens, topics and Treasury, and no keys", () => {
    expect(catalogEnvProblems(env)).toEqual([]);
    expect(catalogEnvProblems({ ...env, TREASURY_ID: undefined })).toEqual(["TREASURY_ID is not set"]);
  });
});

describe("ipfs.js", () => {
  const reply = (status, text) => ({ ok: status === 200, status, text: async () => text });
  const sleep = jest.fn(async () => {});

  beforeEach(() => sleep.mockClear());

  test("the gateway: IPFS_GATEWAY or the default, always ending in /", () => {
    expect(ipfsGateway({})).toBe("https://gateway.pinata.cloud/ipfs/");
    expect(ipfsGateway({ IPFS_GATEWAY: "https://ua.example/ipfs" })).toBe("https://ua.example/ipfs/");
  });

  test("CIDs from ipfs:// URIs and from the mirror node's base64 metadata", () => {
    expect(cidOfUri("ipfs://QmAbc")).toBe("QmAbc");
    expect(cidOfUri("ipfs://QmAbc/x.json")).toBeNull();
    expect(cidOfUri("https://x")).toBeNull();
    expect(cidOfNftMetadata(Buffer.from("ipfs://QmAbc").toString("base64"))).toBe("QmAbc");
    expect(cidOfNftMetadata(undefined)).toBeNull();
  });

  test("reads the JSON through the gateway", async () => {
    const fetchFn = jest.fn(async () => reply(200, '{"a":1}'));
    await expect(fetchIpfsJson("QmA", { gateway: "https://g/ipfs/", fetchFn, sleep })).resolves.toEqual({ a: 1 });
    expect(fetchFn.mock.calls[0][0]).toBe("https://g/ipfs/QmA");
  });

  test("tries again after a failed request, waiting longer each time", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(reply(429, ""))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(reply(200, "[1]"));
    await expect(fetchIpfsJson("QmA", { gateway: "https://g/", fetchFn, sleep, waitMs: 10 })).resolves.toEqual([1]);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  test("throws after the last try", async () => {
    const fetchFn = jest.fn(async () => reply(503, ""));
    await expect(fetchIpfsJson("QmA", { gateway: "https://g/", fetchFn, sleep, tries: 2 })).rejects.toThrow(
      "cannot read https://g/QmA after 2 tries: HTTP 503",
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("IPFS paths: a CID or <cid>/<file>, safe as a folder name", () => {
    expect(ipfsPathOfUri("ipfs://QmAbc")).toBe("QmAbc");
    expect(ipfsPathOfUri("ipfs://QmAbc/photo_1.png")).toBe("QmAbc/photo_1.png");
    expect(ipfsPathOfUri("ipfs://QmAbc/../x")).toBeNull();
    expect(ipfsPathOfUri("ipfs://QmAbc/a b.png")).toBeNull();
    expect(ipfsPathOfUri("https://x/QmAbc")).toBeNull();
  });

  test("reads a file as bytes, with the same retries", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => bytes });
    await expect(fetchIpfsBytes("QmA/p.png", { gateway: "https://g/", fetchFn, sleep, waitMs: 10 })).resolves.toEqual(bytes);
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual(["https://g/QmA/p.png", "https://g/QmA/p.png"]);
    expect(sleep.mock.calls).toEqual([[10]]);
  });

  test("a file that is not JSON throws NotJsonError at once", async () => {
    const fetchFn = jest.fn(async () => reply(200, "<html>"));
    await expect(fetchIpfsJson("QmA", { gateway: "https://g/", fetchFn, sleep })).rejects.toBeInstanceOf(NotJsonError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("tokenNfts", () => {
  const reply = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => "" });

  test("follows the pages, burned NFTs included", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(reply(200, { nfts: [nft(1)], links: { next: "/api/v1/tokens/0.0.2002/nfts?next" } }))
      .mockResolvedValueOnce(reply(200, { nfts: [nft(2, null, { deleted: true })], links: { next: null } }));
    const nfts = await tokenNfts(UMINA, fetchFn);
    expect(nfts.map((n) => [n.serial_number, n.deleted])).toEqual([[1, false], [2, true]]);
    expect(fetchFn.mock.calls[0][0]).toBe("https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.2002/nfts?limit=100&order=asc");
  });

  test("a token the mirror node does not know is an error", async () => {
    await expect(tokenNfts(UMINA, jest.fn(async () => reply(404, {})))).rejects.toThrow("token 0.0.2002 was not found");
  });
});
