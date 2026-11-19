import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { withPlaceholderAssets } from "../src/mint/lib.js";
import { actualSdk } from "../testHelpers/actualSdk.js";

// Runs src/catalog/buildCatalog.js itself (it runs on import) with dotenv,
// the Hedera client, the mirror node and the IPFS gateway mocked; the catalog
// is written to a real temporary folder (umina-achala-chain#44).

const UMINA = "0.0.2002";
const ACHALA = "0.0.2003";
const TREASURY = "0.0.1001";
const PROVENANCE = "0.0.3003";
const DISPLAY = "0.0.3004";
const BUYER = "0.0.6006";
const MIRROR = "https://testnet.mirrornode.hedera.com";
const GATEWAY = "https://gateway.pinata.cloud/ipfs/";

const uminaMetadata = (stoneId) => {
  const m = withPlaceholderAssets(JSON.parse(fs.readFileSync("json/umina-example.json", "utf8")));
  m.properties.stone_id = stoneId;
  return m;
};
const achalaMetadata = () => {
  const m = withPlaceholderAssets(JSON.parse(fs.readFileSync("json/achala-example.json", "utf8")));
  m.properties.stone_id = "ACHALA-2026-PE-02";
  m.properties.stones = [{ serial: 8, stone_id: "UMINA-2026-AU-01" }];
  m.properties.umina_token_id = UMINA;
  return m;
};

const mint = (tokenId, serial, stoneId, extra = {}) => ({
  event: "MINT", token_id: tokenId, serials: [String(serial)], stone_id: stoneId, ...extra,
});
const provenanceEvents = [
  { event: "COMPLIANCE", token_id: UMINA, serials: [], stone_id: "UMINA-2026-AG-01" },
  mint(UMINA, 7, "UMINA-2026-AG-01"),
  mint(UMINA, 8, "UMINA-2026-AU-01"),
  mint(UMINA, 9, "UMINA-2026-OP-01"),
  mint(ACHALA, 1, "ACHALA-2026-PE-02", { from_stone_ids: ["UMINA-2026-AU-01"] }),
];
const listed = (ts, tokenId, serial, price) => ({
  ts, event: { event: "LISTED", token_id: tokenId, serials: [String(serial)], price, currency: "HBAR" },
});
const defaultDisplay = [listed("10.0", UMINA, 7, "45"), listed("11.0", ACHALA, 1, "120")];

const nft = (serial, account_id = TREASURY, extra = {}) => ({
  serial_number: serial, account_id, deleted: false,
  metadata: Buffer.from(`ipfs://Qm${serial}x`).toString("base64"), ...extra,
});
const defaultNfts = () => ({
  [UMINA]: [nft(7), nft(8), nft(9)],
  [ACHALA]: [{ ...nft(1), metadata: Buffer.from("ipfs://QmAchala1").toString("base64") }],
});
const defaultFiles = () => ({
  Qm7x: uminaMetadata("UMINA-2026-AG-01"),
  Qm8x: uminaMetadata("UMINA-2026-AU-01"),
  Qm9x: uminaMetadata("UMINA-2026-OP-01"),
  QmAchala1: achalaMetadata(),
});

const calls = {};

/**
 * display: [{ ts, event }]; nfts: { token: [nft] }; arrivals: { "token/serial": ts }
 * (default "1.0"); files: { cid: json | string | status number }.
 */
function mockDependencies({ display = defaultDisplay, nfts = defaultNfts(), arrivals = {}, files = defaultFiles() } = {}) {
  calls.urls = [];
  calls.gateway = [];
  calls.forTestnet = jest.fn();
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
  jest.doMock("@hashgraph/sdk", () => ({ ...actualSdk(), Client: { forTestnet: calls.forTestnet } }));
  const reply = (status, body) => ({
    ok: status === 200,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  global.fetch = jest.fn(async (url) => {
    calls.urls.push(url);
    if (!url.startsWith(MIRROR)) {
      const cid = url.slice(url.lastIndexOf("/") + 1);
      calls.gateway.push(cid);
      const file = files[cid];
      if (typeof file === "number") return reply(file, "");
      return file === undefined ? reply(404, "") : reply(200, typeof file === "string" ? file : JSON.stringify(file));
    }
    const p = url.replace(MIRROR, "");
    let m;
    if ((m = /^\/api\/v1\/topics\/([\d.]+)\/messages/.exec(p))) {
      const list = m[1] === DISPLAY ? display : provenanceEvents.map((event, i) => ({ ts: `${i + 1}.0`, event }));
      return reply(200, {
        messages: list.map((e, i) => ({
          sequence_number: i + 1,
          consensus_timestamp: e.ts,
          message: Buffer.from(JSON.stringify(e.event)).toString("base64"),
        })),
        links: { next: null },
      });
    }
    if (/^\/api\/v1\/topics\/[\d.]+$/.test(p)) return reply(200, { deleted: false });
    if ((m = /^\/api\/v1\/tokens\/([\d.]+)\/nfts\/(\d+)\/transactions/.exec(p))) {
      return reply(200, {
        transactions: [{ consensus_timestamp: arrivals[`${m[1]}/${m[2]}`] ?? "1.0", receiver_account_id: TREASURY }],
        links: { next: null },
      });
    }
    if ((m = /^\/api\/v1\/tokens\/([\d.]+)\/nfts\?/.exec(p))) {
      return reply(200, { nfts: nfts[m[1]] ?? [], links: { next: null } });
    }
    return reply(404, {});
  });
}

const logs = () => console.log.mock.calls.map((c) => c.join(" ")).join("\n");
const errors = () => console.error.mock.calls.map((c) => c.join(" ")).join("\n");
const tables = () => console.table.mock.calls.map((c) => c[0]);

async function run(...args) {
  process.argv = ["node", "src/catalog/buildCatalog.js", ...args];
  await import("../src/catalog/buildCatalog.js");
  // The script runs on import and ends with a ✅, a dry-run line or an error.
  // It writes real files, so wait by time (up to 5 s), not by a count of turns.
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (/✅ Wrote|Dry run:/.test(logs()) || console.error.mock.calls.length) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("buildCatalog.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  const fetchBefore = global.fetch;
  let dir;
  let file;

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      NETWORK: "testnet",
      UMINA_TOKEN_ID: UMINA,
      ACHALA_TOKEN_ID: ACHALA,
      HCS_TOPIC_ID: PROVENANCE,
      HCS_DISPLAY_TOPIC_ID: DISPLAY,
      TREASURY_ID: TREASURY,
    });
    delete process.env.IPFS_GATEWAY;
    process.exitCode = undefined;
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "table").mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    file = path.join(dir, "catalog.json");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
    process.argv = argv;
    global.fetch = fetchBefore;
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writes only what the Treasury has listed, with metadata, price, events and an Achala's stones", async () => {
    mockDependencies();
    await run(dir);
    expect(errors()).toBe("");
    expect(process.exitCode).toBeUndefined();
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(catalog.network).toBe("testnet");
    expect(catalog.source).toMatchObject({ provenance_seq: 5, display_seq: 2, treasury_id: TREASURY, ipfs_gateway: GATEWAY });
    expect(catalog.items.map((i) => [i.kind, i.serial, i.stone_id, i.price.amount])).toEqual([
      ["umina", 7, "UMINA-2026-AG-01", "45"],
      ["achala", 1, "ACHALA-2026-PE-02", "120"],
    ]);
    expect(catalog.items[0].metadata.properties.stone_id).toBe("UMINA-2026-AG-01");
    expect(catalog.items[0].events.map((e) => e.event.event)).toEqual(["COMPLIANCE", "MINT"]);
    expect(catalog.items[1].stones.map((s) => [s.serial, s.stone_id, s.metadata_cid])).toEqual([[8, "UMINA-2026-AU-01", "Qm8x"]]);
    expect(catalog.items[1].stones[0].events.map((e) => e.seq)).toEqual([3, 5]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    // the mounted stone and the unlisted one are left out, with their reasons
    const leftOut = tables()[1];
    expect(leftOut.map((r) => [r.serial, r.reason])).toEqual([
      [8, "mounted in ACHALA-2026-PE-02, sold with it"],
      [9, "not listed"],
    ]);
    // read-only: no Hedera client, no transaction
    expect(calls.forTestnet).not.toHaveBeenCalled();
  });

  test("a second build reads no metadata again and differs only in built_at", async () => {
    mockDependencies();
    await run(dir);
    const first = JSON.parse(fs.readFileSync(file, "utf8"));
    jest.resetModules();
    console.log.mockClear();
    mockDependencies();
    await run(dir);
    expect(calls.gateway).toEqual([]);
    expect(logs()).toMatch("Metadata: 0 read through the gateway, 3 from the previous catalog.");
    const second = JSON.parse(fs.readFileSync(file, "utf8"));
    expect({ ...second, built_at: "" }).toEqual({ ...first, built_at: "" });
  });

  test("--dry-run prints what would be in the catalog and writes nothing", async () => {
    mockDependencies();
    await run(dir, "--dry-run");
    expect(logs()).toMatch(/Dry run: would write 2 items/);
    expect(tables()[0].map((r) => r.stone_id)).toEqual(["UMINA-2026-AG-01", "ACHALA-2026-PE-02"]);
    expect(fs.existsSync(file)).toBe(false);
  });

  test("a gateway failure stops the build and leaves the old catalog", async () => {
    fs.writeFileSync(file, '{"old":true}');
    jest.spyOn(global, "setTimeout").mockImplementation((fn) => (fn(), 0));
    mockDependencies({ files: { ...defaultFiles(), Qm7x: 503 } });
    await run(dir);
    expect(errors()).toMatch("Catalog build failed");
    expect(errors()).toMatch("after 3 tries: HTTP 503");
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe('{"old":true}');
  });

  test("an item with metadata that is not valid or not JSON is left out, with a warning", async () => {
    const bad = uminaMetadata("UMINA-2026-AG-01");
    delete bad.properties.hs_code;
    mockDependencies({ files: { ...defaultFiles(), Qm7x: bad, QmAchala1: "<html>" } });
    await run(dir);
    expect(process.exitCode).toBeUndefined();
    expect(logs()).toMatch(/⚠️ {2}UMINA-2026-AG-01 \(0\.0\.2002\/7\) is left out: its metadata Qm7x is not valid/);
    expect(logs()).toMatch(/ACHALA-2026-PE-02 .* its metadata QmAchala1 is not JSON/);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).items).toEqual([]);
  });

  test("an item sold and returned is not listed by its old LISTED", async () => {
    mockDependencies({ arrivals: { [`${UMINA}/7`]: "20.0" } });
    await run(dir);
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(catalog.items.map((i) => i.stone_id)).toEqual(["ACHALA-2026-PE-02"]);
    expect(tables()[1]).toContainEqual(
      expect.objectContaining({ serial: 7, reason: "not listed since it last arrived in the Treasury" }),
    );
  });

  test("an Achala whose stone the Treasury no longer holds is left out", async () => {
    const nfts = defaultNfts();
    nfts[UMINA][1] = nft(8, BUYER);
    mockDependencies({ nfts });
    await run(dir);
    expect(logs()).toMatch(`ACHALA-2026-PE-02 (${ACHALA}/1) is left out: its stone UMINA-2026-AU-01 (serial 8) is held by ${BUYER}`);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).items.map((i) => i.kind)).toEqual(["umina"]);
  });

  test("IPFS_GATEWAY changes the gateway", async () => {
    process.env.IPFS_GATEWAY = "https://ua.example/ipfs";
    mockDependencies();
    await run(dir, "--dry-run");
    expect(calls.urls.filter((u) => u.startsWith("https://ua.example/ipfs/"))).toHaveLength(3);
  });

  test("refuses a missing folder or environment before reading anything", async () => {
    mockDependencies();
    await run();
    expect(errors()).toMatch("give the folder to write catalog.json to");
    jest.resetModules();
    console.error.mockClear();
    delete process.env.TREASURY_ID;
    mockDependencies();
    await run(dir);
    expect(errors()).toMatch("TREASURY_ID is not set");
    expect(calls.urls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
