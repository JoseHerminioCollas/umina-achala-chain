import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { PrivateKey } from "@hashgraph/sdk";
import { actualSdk } from "../testHelpers/actualSdk.js";

// Runs src/mint/mintNFT.js itself (it calls main() on import) with Hedera,
// Pinata (fetch) and dotenv mocked, and records what it sends.

const key = PrivateKey.generateECDSA().toStringDer();
const calls = {};

function mockDependencies({
  pinStatus = 200,
  mintError,
  hcsError,
  hcsReceiptError,
  complianceError,
  mirrorStatus = 200,
  topicEvents = [],
  nfts = {},
} = {}) {
  calls.order = [];
  calls.messages = [];
  calls.mirror = [];
  calls.mint = null;
  calls.signed = [];
  calls.hcs = null;
  calls.pin = null;
  calls.files = [];
  calls.close = jest.fn();
  calls.forTestnet = jest.fn(() => ({
    setOperator: jest.fn().mockReturnThis(),
    close: calls.close,
  }));

  jest.doMock("dotenv", () => ({
    __esModule: true,
    default: { config: jest.fn() },
  }));

  jest.doMock("@hashgraph/sdk", () => ({
    ...actualSdk(),
    Client: { forTestnet: calls.forTestnet },
    TokenMintTransaction: jest.fn().mockImplementation(() => {
      const tx = {
        setTokenId: jest.fn((id) => ((calls.mint = { tokenId: id }), tx)),
        setMetadata: jest.fn((m) => ((calls.mint.metadata = m), tx)),
        freezeWith: jest.fn(() => tx),
        sign: jest.fn(async (k) => (calls.signed.push(k.publicKey.toString()), tx)),
        execute: jest.fn(async () => {
          calls.order.push("mint");
          if (mintError) throw mintError;
          return {
            transactionId: { toString: () => "0.0.1001@1700000000.0" },
            getReceipt: async () => ({ serials: [7] }),
          };
        }),
      };
      return tx;
    }),
    TopicMessageSubmitTransaction: jest.fn().mockImplementation(() => {
      const tx = {
        setTopicId: jest.fn((id) => ((calls.hcs = { topicId: id, signed: [] }), tx)),
        setMessage: jest.fn((m) => ((calls.hcs.message = JSON.parse(m)), tx)),
        freezeWith: jest.fn(() => tx),
        sign: jest.fn(async (k) => (calls.hcs.signed.push(k.publicKey.toString()), tx)),
        execute: jest.fn(async () => {
          calls.messages.push(calls.hcs.message);
          // The COMPLIANCE event before pinning is recorded apart from MINT,
          // and the hcs errors apply to MINT only
          if (calls.hcs.message.event === "COMPLIANCE") {
            calls.order.push("compliance");
            calls.compliance = calls.hcs;
            if (complianceError) throw complianceError;
            return {
              transactionId: { toString: () => "0.0.1001@1699999999.000000000" },
              getReceipt: async () => ({ status: "SUCCESS" }),
            };
          }
          calls.order.push("hcs");
          if (hcsError) throw hcsError;
          return {
            transactionId: { toString: () => "0.0.1@1700000000.1" },
            getReceipt: async () => {
              if (hcsReceiptError) throw hcsReceiptError;
              return { status: "SUCCESS" };
            },
          };
        }),
      };
      return tx;
    }),
  }));

  global.fetch = jest.fn(async (url, init) => {
    // An NFT's state: nfts["<token>/<serial>"], by default held by the treasury
    const nft = /\/api\/v1\/tokens\/([\d.]+)\/nfts\/(\d+)$/.exec(url);
    if (nft) {
      calls.mirror.push(url);
      const key = `${nft[1]}/${nft[2]}`;
      const info = key in nfts ? nfts[key] : { account_id: "0.0.1001", deleted: false };
      return {
        ok: info !== null,
        status: info === null ? 404 : 200,
        text: async () => "not found",
        json: async () => info,
      };
    }
    if (url.startsWith("https://testnet.mirrornode.hedera.com/")) {
      // The HCS topic's messages, one page, base64-encoded as the mirror node does
      calls.mirror.push(url);
      return {
        ok: mirrorStatus === 200,
        status: mirrorStatus,
        text: async () => "mirror says no",
        json: async () => ({
          messages: topicEvents.map((event, i) => ({
            sequence_number: i + 1,
            message: Buffer.from(JSON.stringify(event)).toString("base64"),
          })),
          links: { next: null },
        }),
      };
    }
    if (url.endsWith("pinFileToIPFS")) {
      calls.order.push("pinFile");
      calls.files.push({
        name: init.body.get("file").name,
        type: init.body.get("file").type,
        metadataName: JSON.parse(init.body.get("pinataMetadata")).name,
      });
      return {
        ok: pinStatus === 200,
        status: pinStatus,
        text: async () => "pinata says no",
        json: async () => ({ IpfsHash: `QmFile${calls.files.length}` }),
      };
    }
    calls.order.push("pin");
    calls.pin = { url, headers: init.headers, body: JSON.parse(init.body) };
    return {
      ok: pinStatus === 200,
      status: pinStatus,
      text: async () => "pinata says no",
      json: async () => ({ IpfsHash: "QmMockCID12345" }),
    };
  });
}

// Image versions go to a temp folder unless a test gives its own --out
let outDir;

async function runScript(...args) {
  const out = args.includes("--out") ? [] : ["--out", outDir];
  process.argv = ["node", "src/mint/mintNFT.js", ...args, ...out];
  const { done } = await import("../src/mint/mintNFT.js");
  await done;
}

// Writes a metadata file (the example template plus a list of images) and the
// image files it names into a temp folder, and returns the metadata file path.
// A real 1600×1200 JPEG (made once in beforeAll), so sharp can read the photos
let photo;

// The first image name becomes main_image and the rest go in images.
function writeMetadata(change = () => {}, imageNames = ["front.jpg", "back.jpg"], documentNames = []) {
  const metadata = JSON.parse(fs.readFileSync("json/umina-example.json", "utf8"));
  // The example names its own photos in testnet/; each test names its own
  delete metadata.main_image;
  delete metadata.images;
  const entry = (name) => ({ file: name, description: `${name} description` });
  const [main, ...others] = imageNames;
  if (main) metadata.main_image = entry(main);
  if (others.length) metadata.images = others.map(entry);
  if (documentNames.length) metadata.documents = documentNames.map(entry);
  change(metadata);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-"));
  new Set(imageNames).forEach((name) => fs.writeFileSync(path.join(dir, name), photo));
  new Set(documentNames).forEach((name) => fs.writeFileSync(path.join(dir, name), "data"));
  const file = path.join(dir, "metadata.json");
  fs.writeFileSync(file, JSON.stringify(metadata));
  return file;
}

describe("mintNFT.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  const fetchBefore = global.fetch;

  beforeAll(async () => {
    const sharp = (await import("sharp")).default;
    photo = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: { r: 40, g: 120, b: 160 } },
    })
      .jpeg()
      .toBuffer();
  });

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-out-"));
  });
  let log;

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      OPERATOR_ID: "0.0.1001",
      OPERATOR_KEY: key,
      SUPPLY_KEY: key,
      UMINA_TOKEN_ID: "0.0.2002",
      HCS_TOPIC_ID: "0.0.3003",
      PINATA_JWT: "test-jwt",
    });
    log = jest.spyOn(console, "log").mockImplementation(() => {});
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

  test("pins the images first, then the metadata, then mints, then notarizes", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test("pins each image with its name, MIME type and the Pinata JWT", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    // The main photo's master and display version, then the other photo's master
    expect(calls.files).toEqual([
      { name: "01-master.jpg", type: "image/jpeg", metadataName: "UMINA-2026-CH-03-01-master.jpg" },
      { name: "01-display.jpg", type: "image/jpeg", metadataName: "UMINA-2026-CH-03-01-display.jpg" },
      { name: "02-master.jpg", type: "image/jpeg", metadataName: "UMINA-2026-CH-03-02-master.jpg" },
    ]);
    expect(calls.pin.headers.authorization).toBe("Bearer test-jwt");
  });

  test("image is the display version; files has each master with its checksum, the main one default", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    const pinned = calls.pin.body.pinataContent;
    expect(pinned.main_image).toBeUndefined();
    expect(pinned.images).toBeUndefined();
    expect(pinned.image).toBe("ipfs://QmFile2");
    expect(pinned.type).toBe("image/jpeg");
    const checksum = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(pinned.files).toEqual([
      { uri: "ipfs://QmFile1", type: "image/jpeg", is_default_file: true, checksum, metadata: { description: "front.jpg description" } },
      { uri: "ipfs://QmFile3", type: "image/jpeg", is_default_file: false, checksum, metadata: { description: "back.jpg description" } },
    ]);
    expect(calls.pin.body.pinataMetadata.name).toBe("UMINA-2026-CH-03");
  });

  test("writes the versions to <out>/<stone_id>/: the display version 1080 px, the masters full size", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    const sharp = (await import("sharp")).default;
    const dir = path.join(outDir, "UMINA-2026-CH-03");
    const size = async (f) => {
      const m = await sharp(path.join(dir, f)).metadata();
      return [m.width, m.height];
    };
    expect(fs.readdirSync(dir).sort()).toEqual(["01-display.jpg", "01-master.jpg", "02-master.jpg"]);
    expect(await size("01-display.jpg")).toEqual([1080, 810]);
    expect(await size("01-master.jpg")).toEqual([1600, 1200]);
  });

  test("refuses a photo listed twice", async () => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, ["front.jpg", "front.jpg"]));

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/images\[0\]\.file "front\.jpg" is already main_image/),
    );
    expect(calls.order).toEqual([]);
  });

  test("mints under UMINA_TOKEN_ID with the ipfs:// URI, signed by the supply key", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.mint.tokenId).toBe("0.0.2002");
    expect(calls.mint.metadata).toHaveLength(1);
    expect(calls.mint.metadata[0].toString()).toBe("ipfs://QmMockCID12345");
    expect(calls.signed).toEqual([
      PrivateKey.fromStringDer(key).publicKey.toString(),
    ]);
  });

  test("submits a MINT message to HCS_TOPIC_ID with the stone, serials and CID", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.hcs.topicId).toBe("0.0.3003");
    expect(calls.hcs.message).toEqual({
      event: "MINT",
      schema_version: 1,
      stone_id: "UMINA-2026-CH-03",
      token_id: "0.0.2002",
      serials: ["7"],
      actor_id: "0.0.1001",
      occurred_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
      ref: "0.0.1001@1700000000.0",
      ipfs_cid: "QmMockCID12345",
    });
    expect(calls.hcs.signed).toEqual([]);
  });

  test("signs the MINT message with HCS_SUBMIT_KEY when it is set", async () => {
    const submitKey = PrivateKey.generateECDSA();
    process.env.HCS_SUBMIT_KEY = submitKey.toStringDer();
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.hcs.signed).toEqual([submitKey.publicKey.toString()]);
    expect(process.exitCode).not.toBe(1);
  });

  test("rejects an HCS_SUBMIT_KEY that is not an ECDSA key and sends nothing", async () => {
    process.env.HCS_SUBMIT_KEY = "not-a-key";
    mockDependencies();
    await runScript(writeMetadata());

    expect(console.error).toHaveBeenCalledWith(
      "   - HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    );
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("reports a MINT message rejected at consensus as a failed notarization", async () => {
    mockDependencies({ hcsReceiptError: new Error("INVALID_SIGNATURE") });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("but the HCS notarization failed"),
      expect.objectContaining({ message: "INVALID_SIGNATURE" }),
    );
    expect(console.table).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("records COMPLIANCE before pinning and puts its ID in compliance_proof_hcs", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.order[0]).toBe("compliance");
    expect(calls.compliance.message).toMatchObject({
      event: "COMPLIANCE",
      stone_id: "UMINA-2026-CH-03",
      serials: [],
      stone_type: "chrysocolla",
      vendor_ruc: "20999887768",
      mining_concession: "010253815",
      reinfo_id: "10456789124",
      hs_code: "7103.99.00.00",
    });
    expect(calls.pin.body.pinataContent.properties).toMatchObject({
      compliance_proof_hcs: "0.0.1001@1699999999.000000000",
      hcs_compliance_topic: "0.0.3003",
    });
  });

  test("pins nothing when COMPLIANCE cannot be recorded", async () => {
    mockDependencies({ complianceError: new Error("INVALID_SIGNATURE") });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["compliance"]);
    expect(console.error).toHaveBeenCalledWith(
      "❌ Could not record COMPLIANCE for UMINA-2026-CH-03; nothing was pinned or minted:",
      expect.any(Error),
    );
    expect(process.exitCode).toBe(1);
  });

  test("writes Stone Type, Materials and Form from the list, replacing hand-written ones", async () => {
    mockDependencies();
    await runScript(
      writeMetadata((m) => {
        m.properties.stone_type = "quartz";
        m.properties.specimen_form = "natural";
        m.properties.materials = [
          { stone_type: "quartz", role: "host", form: "crystal" },
          { stone_type: "gold", role: "inclusion", form: "leaf", weight_g: 0.4 },
        ];
        m.attributes.unshift({ trait_type: "Stone Type", value: "Quarts" });
      }),
    );

    const attributes = calls.pin.body.pinataContent.attributes;
    expect(attributes.slice(0, 3)).toEqual([
      { trait_type: "Stone Type", value: "Quartz" },
      { trait_type: "Materials", value: "Quartz, Gold" },
      { trait_type: "Form", value: "Natural" },
    ]);
    expect(attributes.filter((a) => a.trait_type === "Stone Type")).toHaveLength(1);
  });

  test.each([
    ["a stone type not in the list", (m) => (m.properties.stone_type = "unobtainium"), /"unobtainium" is not in schema\/stone-types.json/],
    ["a fossil", (m) => (m.properties.stone_type = "ammonite"), /"ammonite" is a fossil; fossils are not minted/],
    ["a fossil among the materials", (m) => (m.properties.materials = [
      { stone_type: "chrysocolla", role: "host" },
      { stone_type: "petrified_wood", role: "inclusion" },
    ]), /petrified_wood" is a fossil/],
    ["a RUC with a wrong check digit", (m) => (m.properties.vendor_ruc = "20999887766"), /not a valid RUC/],
    ["a RUC that is not 11 digits", (m) => (m.properties.vendor_ruc = "2099988"), /vendor_ruc/],
    ["a REINFO ID that is not a RUC", (m) => (m.properties.reinfo_id = "PERU-MIN-445566"), /reinfo_id/],
    ["a REINFO RUC with a wrong check digit", (m) => (m.properties.reinfo_id = "10456789120"), /reinfo_id .*not a valid RUC/],
    ["a concession code that is not 9 digits", (m) => (m.properties.mining_concession = "Arequipa-Chrys-03"), /mining_concession/],
    ["a missing stone type", (m) => delete m.properties.stone_type, /stone_type/],
  ])("refuses %s before anything is sent", async (_, change, message) => {
    mockDependencies();
    await runScript(writeMetadata(change));

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("lists missing variables and sends nothing", async () => {
    delete process.env.PINATA_JWT;
    delete process.env.HCS_TOPIC_ID;
    mockDependencies();
    await runScript(writeMetadata());

    expect(console.error).toHaveBeenCalledWith("   - HCS_TOPIC_ID is not set");
    expect(console.error).toHaveBeenCalledWith("   - PINATA_JWT is not set");
    expect(calls.order).toEqual([]);
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("rejects a stone_id outside the UMINA-YYYY-XX-NN scheme", async () => {
    mockDependencies();
    await runScript(writeMetadata((m) => (m.properties.stone_id = "Chrysocolla-2026-05-10T12:00:00Z")));

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("properties.stone_id must look like UMINA-2026-CH-03"),
    );
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("rejects metadata that fails the HIP-412 schema", async () => {
    mockDependencies();
    await runScript(writeMetadata((m) => delete m.properties.hs_code));

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("failed validation"),
    );
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("requires main_image", async () => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, []));

    expect(console.error).toHaveBeenCalledWith(
      "   - main_image is required: the photo whose display version becomes `image`",
    );
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("refuses more than 20 photos besides main_image (#35)", async () => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, Array.from({ length: 22 }, (_, i) => `${i}.jpg`)));

    expect(console.error).toHaveBeenCalledWith("   - images lists 21 photos; at most 20 besides main_image");
    expect(calls.order).toEqual([]);
  });

  test.each([
    ["GIF", "photo.gif", /GIF has 256 colours/],
    ["HEIC", "IMG_0001.HEIC", /HEIC \(an iPhone photo\) is not supported; export or share it as JPEG/],
    ["a RAW file", "photo.dng", /is not a JPEG, PNG or WebP photo/],
  ])("refuses %s by its extension", async (_, name, message) => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, [name]));

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(message));
    expect(calls.order).toEqual([]);
  });

  test("refuses a file that is not really an image, whatever its extension", async () => {
    mockDependencies();
    const file = writeMetadata();
    fs.writeFileSync(path.join(path.dirname(file), "front.jpg"), "not a photo");
    await runScript(file);

    expect(console.error).toHaveBeenCalledWith(
      "   - main_image is not an image sharp can read (JPEG, PNG or WebP)",
    );
    expect(calls.order).toEqual([]);
  });

  test("lists an image file that does not exist and sends nothing", async () => {
    mockDependencies();
    const file = writeMetadata((m) => m.images.push({ file: "gone.jpg" }));
    // (back.jpg exists; gone.jpg does not)
    await runScript(file);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("file not found:"));
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run lists the versions it would make, writes none, sends nothing", async () => {
    mockDependencies();
    await runScript(writeMetadata(), "--dry-run");

    const dir = path.join(outDir, "UMINA-2026-CH-03");
    expect(log).toHaveBeenCalledWith(`Would make ${dir}/01-master.jpg (image/jpeg, 1600×1200)`);
    expect(log).toHaveBeenCalledWith(`Would make ${dir}/01-display.jpg (image/jpeg, 1080×810)`);
    expect(log).toHaveBeenCalledWith(`Would make ${dir}/02-master.jpg (image/jpeg, 1600×1200)`);
    expect(log).toHaveBeenCalledWith("Dry run, nothing sent.");
    expect(fs.existsSync(dir)).toBe(false);
    expect(calls.order).toEqual([]);
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("--images-only writes the versions and prints the metadata, without credentials or network", async () => {
    delete process.env.PINATA_JWT;
    delete process.env.SUPPLY_KEY;
    delete process.env.UMINA_TOKEN_ID;
    mockDependencies();
    await runScript(writeMetadata(), "--images-only");

    const dir = path.join(outDir, "UMINA-2026-CH-03");
    expect(fs.readdirSync(dir).sort()).toEqual(["01-display.jpg", "01-master.jpg", "02-master.jpg"]);
    expect(log).toHaveBeenCalledWith(`Would pin ${dir}/01-display.jpg (image/jpeg)`);
    expect(log).toHaveBeenCalledWith(
      "Would record COMPLIANCE, mint under not set and record MINT in 0.0.3003.",
    );
    expect(log).toHaveBeenCalledWith("Images only: nothing pinned, minted or recorded.");
    const printed = log.mock.calls.map(([line]) => line).find((line) => String(line).startsWith("{"));
    expect(JSON.parse(printed).files[0]).toMatchObject({
      is_default_file: true,
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(calls.order).toEqual([]);
    expect(calls.mirror).toEqual([]);
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("refuses --dry-run and --images-only together", async () => {
    mockDependencies();
    await runScript(writeMetadata(), "--dry-run", "--images-only");

    expect(console.error).toHaveBeenCalledWith("   - give --dry-run or --images-only, not both");
    expect(process.exitCode).toBe(1);
  });

  test("does not pin the metadata or mint when an image pin fails", async () => {
    mockDependencies({ pinStatus: 401 });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["compliance", "pinFile"]);
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("does not notarize when the mint fails", async () => {
    mockDependencies({ mintError: new Error("TOKEN_HAS_NO_SUPPLY_KEY") });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pin", "mint"]);
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("lists every pinned CID when the mint fails, so they can be unpinned", async () => {
    mockDependencies({ mintError: new Error("TOKEN_HAS_NO_SUPPLY_KEY") });
    await runScript(writeMetadata());

    expect(console.error).toHaveBeenCalledWith(
      "   These pins are not used by any NFT; unpin them in Pinata: ipfs://QmFile1, ipfs://QmFile2, ipfs://QmFile3, ipfs://QmMockCID12345",
    );
  });

  test("lists the images already pinned when a later pin fails", async () => {
    mockDependencies();
    let pins = 0;
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => {
      if (url.endsWith("pinFileToIPFS") && ++pins === 2) {
        return { ok: false, status: 500, text: async () => "down" };
      }
      return realFetch(url, init);
    });
    await runScript(writeMetadata());

    expect(console.error).toHaveBeenCalledWith(
      "   These pins are not used by any NFT; unpin them in Pinata: ipfs://QmFile1",
    );
    expect(process.exitCode).toBe(1);
  });

  test("reads the HCS topic from the mirror node before pinning", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.mirror).toEqual([
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3003",
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3003/messages?limit=100&order=asc",
    ]);
  });

  test("refuses a stone_id that already has a MINT event and pins nothing", async () => {
    mockDependencies({
      topicEvents: [{ event: "MINT", stone_id: "UMINA-2026-CH-03", serials: ["4"] }],
    });
    await runScript(writeMetadata());

    expect(console.error).toHaveBeenCalledWith(
      "❌ UMINA-2026-CH-03 is already minted (MINT event #1, serials 4). Use --force to mint it again.",
    );
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("ignores MINT events for other stones and other event types", async () => {
    mockDependencies({
      topicEvents: [
        { event: "MINT", stone_id: "UMINA-2026-CH-04", serials: ["5"] },
        { event: "SALE", stone_id: "UMINA-2026-CH-03", serials: ["4"] },
      ],
    });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
  });

  test("--force mints a stone_id that already has a MINT event", async () => {
    mockDependencies({
      topicEvents: [{ event: "MINT", stone_id: "UMINA-2026-CH-03", serials: ["4"] }],
    });
    await runScript(writeMetadata(), "--force");

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(process.exitCode).toBeUndefined();
  });

  test("refuses to mint when the HCS topic does not exist, even with --force", async () => {
    mockDependencies({ mirrorStatus: 404 });
    await runScript(writeMetadata(), "--force");

    expect(console.error).toHaveBeenCalledWith(
      "   - cannot read HCS_TOPIC_ID 0.0.3003: HCS topic 0.0.3003 was not found on the mirror node",
    );
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run does not read the mirror node", async () => {
    mockDependencies();
    await runScript(writeMetadata(), "--dry-run");

    expect(calls.mirror).toEqual([]);
  });

  test("reports the minted serials when HCS notarization fails", async () => {
    mockDependencies({ hcsError: new Error("TOPIC_EXPIRED") });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Minted serials 7 (ipfs://QmMockCID12345)"),
      expect.any(Error),
    );
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("pins documents after the images and lists them after the images in files", async () => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, ["front.jpg"], ["receipt.pdf", "permit.pdf"]));

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(calls.files.map((f) => [f.name, f.type])).toEqual([
      ["01-master.jpg", "image/jpeg"],
      ["01-display.jpg", "image/jpeg"],
      ["receipt.pdf", "application/pdf"],
      ["permit.pdf", "application/pdf"],
    ]);
    const pinned = calls.pin.body.pinataContent;
    expect(pinned.documents).toBeUndefined();
    expect(pinned.image).toBe("ipfs://QmFile2");
    expect(pinned.files).toEqual([
      {
        uri: "ipfs://QmFile1",
        type: "image/jpeg",
        is_default_file: true,
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        metadata: { description: "front.jpg description" },
      },
      { uri: "ipfs://QmFile3", type: "application/pdf", metadata: { description: "receipt.pdf description" } },
      { uri: "ipfs://QmFile4", type: "application/pdf", metadata: { description: "permit.pdf description" } },
    ]);
  });

  test("lists a document file that does not exist and sends nothing", async () => {
    mockDependencies();
    const file = writeMetadata((m) => m.documents = [{ file: "gone.pdf" }]);
    await runScript(file);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("file not found:"));
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("rejects a document type that is not supported", async () => {
    mockDependencies();
    await runScript(writeMetadata((m) => m.documents = [{ file: "notes.docx" }], ["thumb.jpg"], []));

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("is not a supported document type"),
    );
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run lists the documents too", async () => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, ["thumb.jpg"], ["receipt.pdf"]), "--dry-run");

    expect(log).toHaveBeenCalledWith(expect.stringContaining("receipt.pdf (application/pdf)"));
    expect(calls.order).toEqual([]);
  });

  // Writes a simulated form post and the files it uploads into a temp folder
  function writeFormPost(change = () => {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-form-"));
    fs.writeFileSync(path.join(dir, "front.jpg"), photo);
    fs.writeFileSync(path.join(dir, "receipt.pdf"), "data");
    const post = {
      name: "Stone from the form",
      description: "Posted through the mint form",
      stone_id: "UMINA-2026-CH-77",
      stone_type: "chrysocolla",
      specimen_form: "worked",
      hs_code: "7103.99.00.00",
      jurisdiction: "Peru",
      legal_uri: "https://umina-achala.pe/",
      vendor_name: "Umiña Achala",
      vendor_ruc: "20999887768",
      mining_concession: "010253815",
      reinfo_id: "10456789124",
      // A hand-written Stone Type is replaced by the one from the list
      attributes: { "Stone Type": "chrysocola (typo)" },
      main_image: { file: "front.jpg", description: "Front view" },
      documents: [{ file: "receipt.pdf", description: "Store receipt" }],
    };
    change(post);
    const file = path.join(dir, "post.json");
    fs.writeFileSync(file, JSON.stringify(post));
    return { file, outDir: path.join(dir, "generated") };
  }

  test("--form generates the metadata file from the post, then mints it", async () => {
    mockDependencies();
    const { file, outDir } = writeFormPost();
    await runScript("--form", file, "--out", outDir);

    const generated = JSON.parse(fs.readFileSync(path.join(outDir, "UMINA-2026-CH-77.json"), "utf8"));
    expect(generated.properties.stone_id).toBe("UMINA-2026-CH-77");
    expect(generated.main_image.file).toBe(path.join(path.dirname(file), "front.jpg"));

    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    const pinned = calls.pin.body.pinataContent;
    expect(pinned.name).toBe("Stone from the form");
    expect(pinned.attributes).toEqual([
      { trait_type: "Stone Type", value: "Chrysocolla" },
      { trait_type: "Form", value: "Worked" },
    ]);
    expect(pinned.files.map((f) => f.metadata.description)).toEqual(["Front view", "Store receipt"]);
    expect(calls.hcs.message.stone_id).toBe("UMINA-2026-CH-77");
    expect(process.exitCode).toBeUndefined();
  });

  test("--form with a missing compliance field is rejected before anything is pinned", async () => {
    mockDependencies();
    const { file, outDir } = writeFormPost((p) => delete p.reinfo_id);
    await runScript("--form", file, "--out", outDir);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed validation"));
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("--form --dry-run writes the metadata file but sends nothing", async () => {
    mockDependencies();
    const { file, outDir } = writeFormPost();
    await runScript("--form", file, "--out", outDir, "--dry-run");

    expect(fs.existsSync(path.join(outDir, "UMINA-2026-CH-77.json"))).toBe(true);
    expect(calls.order).toEqual([]);
    expect(log).toHaveBeenCalledWith("Dry run, nothing sent.");
  });

  test("with no metadata file and no --form it prints the usage and sends nothing", async () => {
    mockDependencies();
    await runScript();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Give a form post or a metadata file"));
    expect(calls.order).toEqual([]);
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // --- Achala (umina-achala-chain#16) ---

  // An Achala metadata file from json/achala-example.json, with its own photo
  function writeAchala(change = () => {}, documentNames = []) {
    return writeMetadata(
      (m) => {
        const achala = JSON.parse(fs.readFileSync("json/achala-example.json", "utf8"));
        const { main_image, documents } = m;
        for (const key of Object.keys(m)) delete m[key];
        Object.assign(m, achala, { main_image }, documents && { documents });
        delete m.images;
        change(m);
      },
      ["front.jpg"],
      documentNames,
    );
  }

  // The provenance topic once both stones of the example are minted
  const stoneEvents = [
    { event: "COMPLIANCE", stone_id: "UMINA-2026-CH-03", token_id: "0.0.2002", serials: [], stone_type: "chrysocolla" },
    { event: "MINT", stone_id: "UMINA-2026-CH-03", token_id: "0.0.2002", serials: ["3"] },
    { event: "COMPLIANCE", stone_id: "UMINA-2026-AU-01", token_id: "0.0.2002", serials: [], stone_type: "gold" },
    { event: "MINT", stone_id: "UMINA-2026-AU-01", token_id: "0.0.2002", serials: ["4"] },
  ];

  function achalaEnv() {
    Object.assign(process.env, { ACHALA_TOKEN_ID: "0.0.4004", TREASURY_ID: "0.0.1001" });
  }

  test("--token achala checks the stones, mints under ACHALA_TOKEN_ID, records MINT with its stones and no stone events", async () => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents });
    await runScript(writeAchala(), "--token", "achala");

    expect(calls.mirror).toEqual(
      expect.arrayContaining([
        "https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.2002/nfts/3",
        "https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.2002/nfts/4",
      ]),
    );
    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(calls.mint.tokenId).toBe("0.0.4004");

    const [compliance, mint, ...others] = calls.messages;
    expect(compliance).toMatchObject({
      event: "COMPLIANCE",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.4004",
      piece_type: "ring",
      artisan_rna: "RNA-112233",
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
    });
    expect(mint).toMatchObject({
      event: "MINT",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.4004",
      serials: ["7"],
      ipfs_cid: "QmMockCID12345",
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
    });
    expect(others).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  test("an Achala's attributes are written from its data, stone names from their COMPLIANCE events", async () => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents });
    await runScript(writeAchala((m) => m.attributes.push({ trait_type: "Stones", value: "typed by hand" })), "--token", "achala");

    expect(calls.pin.body.pinataContent.attributes).toEqual([
      { trait_type: "Piece Type", value: "Ring" },
      { trait_type: "Metal", value: "Gold 18k" },
      { trait_type: "Stones", value: "Chrysocolla, Gold" },
      { trait_type: "Artisan", value: "RNA-112233" },
      { trait_type: "Ring Size", value: "7" },
    ]);
  });

  test.each([
    ["is held by someone else", { nfts: { "0.0.2002/3": { account_id: "0.0.5005", deleted: false } } }, "UMINA-2026-CH-03: 0.0.2002/3 is held by 0.0.5005, not the treasury 0.0.1001"],
    ["is burned", { nfts: { "0.0.2002/3": { account_id: "0.0.1001", deleted: true } } }, "UMINA-2026-CH-03: 0.0.2002/3 is burned"],
    ["does not exist", { nfts: { "0.0.2002/3": null } }, "UMINA-2026-CH-03: 0.0.2002/3 does not exist"],
    ["has no MINT event with that serial", { topicEvents: stoneEvents.filter((e) => e.serials[0] !== "3") }, "UMINA-2026-CH-03: no MINT event for it with serial 0.0.2002/3"],
    [
      "is mounted in another Achala",
      {
        topicEvents: [
          ...stoneEvents,
          { event: "MINT", stone_id: "ACHALA-2026-RI-02", token_id: "0.0.4004", serials: ["2"], from_stone_ids: ["UMINA-2026-CH-03"] },
        ],
      },
      "UMINA-2026-CH-03 is already mounted in Achala ACHALA-2026-RI-02 (0.0.4004/2, MINT #5)",
    ],
  ])("refuses a stone that %s, and sends nothing", async (_, options, problem) => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents, ...options });
    await runScript(writeAchala(), "--token", "achala", "--force");

    expect(console.error).toHaveBeenCalledWith(`   - ${problem}`);
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("a stone whose Achala was burned (taken apart) can be mounted again", async () => {
    achalaEnv();
    mockDependencies({
      topicEvents: [
        ...stoneEvents,
        { event: "MINT", stone_id: "ACHALA-2026-RI-02", token_id: "0.0.4004", serials: ["2"], from_stone_ids: ["UMINA-2026-CH-03"] },
        { event: "BURN", token_id: "0.0.4004", serials: ["2"], reason: "Piece disassembled" },
      ],
    });
    await runScript(writeAchala(), "--token", "achala");

    expect(calls.order).toContain("mint");
    expect(process.exitCode).toBeUndefined();
  });

  test("refuses stones from another token before reading the ledger", async () => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents });
    await runScript(writeAchala((m) => (m.properties.umina_token_id = "0.0.9999")), "--token", "achala");

    expect(console.error).toHaveBeenCalledWith(
      "   - properties.umina_token_id 0.0.9999 is not the Umiña token 0.0.2002 (UMINA_TOKEN_ID)",
    );
    expect(calls.mirror).toEqual([]);
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("a stone may not name its own token_id: the token is umina_token_id", async () => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents });
    await runScript(writeAchala((m) => (m.properties.stones[0].token_id = "0.0.2002")), "--token", "achala", "--dry-run");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("must NOT have additional properties"));
    expect(process.exitCode).toBe(1);
  });

  test.each([
    ["no stones", (m) => (m.properties.stones = []), "must NOT have fewer than 1 items"],
    ["a stone listed twice", (m) => m.properties.stones.push(m.properties.stones[0]), "lists serial 3 twice"],
    ["a metal that is not a metal", (m) => (m.properties.metals[0].stone_type = "chrysocolla"), '"chrysocolla" is not a metal'],
    ["a metal from an Umiña not in the piece", (m) => (m.properties.metals[0].stone_id = "UMINA-2026-AU-09"), "its stone_id must be one of properties.stones"],
    ["a metal from an invoice with no document", (m) => (m.properties.metals[0].source = "invoice"), "add the invoice to documents"],
  ])("rejects an Achala with %s before anything is sent", async (_, change, problem) => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents });
    await runScript(writeAchala(change), "--token", "achala");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(problem));
    expect(calls.order).toEqual([]);
    expect(calls.mirror).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("a metal from an invoice is fine with the invoice in documents", async () => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents });
    await runScript(writeAchala((m) => (m.properties.metals[0].source = "invoice"), ["invoice.pdf"]), "--token", "achala", "--dry-run");

    expect(log).toHaveBeenCalledWith("Dry run, nothing sent.");
    expect(process.exitCode).toBeUndefined();
  });

  test("refuses Achala metadata minted as an Umiña, and the other way round, naming --token", async () => {
    mockDependencies();
    await runScript(writeAchala(), "--dry-run");
    expect(console.error).toHaveBeenCalledWith(
      '   - properties.stone_id must look like UMINA-2026-CH-03, got "ACHALA-2026-RI-01" (an Achala ID: give --token achala)',
    );

    jest.resetModules();
    achalaEnv();
    mockDependencies();
    await runScript(writeMetadata(), "--token=achala", "--dry-run");
    expect(console.error).toHaveBeenCalledWith(
      '   - properties.stone_id must look like ACHALA-2026-RI-01, got "UMINA-2026-CH-03" (an Umiña ID: give --token umina)',
    );
    expect(calls.order).toEqual([]);
  });

  test("an Achala needs ACHALA_TOKEN_ID and TREASURY_ID", async () => {
    mockDependencies();
    await runScript(writeAchala(), "--token", "achala", "--dry-run");

    expect(console.error).toHaveBeenCalledWith("   - ACHALA_TOKEN_ID is not set");
    expect(console.error).toHaveBeenCalledWith("   - TREASURY_ID is not set");
    expect(process.exitCode).toBe(1);
  });

  test("a failed Achala MINT event says its stones are not recorded as mounted", async () => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents, hcsError: new Error("INVALID_SIGNATURE") });
    await runScript(writeAchala(), "--token", "achala");

    expect(console.error).toHaveBeenCalledWith(
      "   Without its MINT event the Achala's stones are not recorded as mounted: UMINA-2026-CH-03, UMINA-2026-AU-01.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("--form --token achala sets umina_token_id from UMINA_TOKEN_ID, in the generated file too", async () => {
    achalaEnv();
    mockDependencies({ topicEvents: stoneEvents });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "achala-form-"));
    fs.writeFileSync(path.join(dir, "front.jpg"), photo);
    // A form post of its own: the sample posts live in the git-ignored testnet/ link
    const post = {
      name: "Achala Pendant #99 - Chrysocolla in Gold",
      description: "Test pendant submitted through the mint form.",
      stone_id: "ACHALA-2026-PE-99",
      piece_type: "pendant",
      stones: [{ serial: 3, stone_id: "UMINA-2026-CH-03" }],
      metals: [{ stone_type: "gold", fineness: "18k", weight_g: 2, source: "umina", stone_id: "UMINA-2026-CH-03" }],
      technique: "Wire wrapping",
      artisan_rna: "RNA-112233",
      hs_code: "7113.11.00.00",
      jurisdiction: "Peru",
      legal_uri: "https://umina-achala.pe/",
      creator: "Joyería Ejemplo S.A.C.",
      vendor_name: "Joyería Ejemplo S.A.C.",
      vendor_ruc: "20999887768",
      attributes: { "Chain Length": "45 cm" },
      main_image: { file: "front.jpg", description: "Front" },
    };
    const file = path.join(dir, "post.json");
    fs.writeFileSync(file, JSON.stringify(post));
    await runScript("--form", file, "--token", "achala", "--out", path.join(dir, "generated"));

    const { properties } = calls.pin.body.pinataContent;
    expect(properties.umina_token_id).toBe("0.0.2002");
    expect(properties.stones).toEqual([{ serial: 3, stone_id: "UMINA-2026-CH-03" }]);
    const generated = JSON.parse(fs.readFileSync(path.join(dir, "generated", "ACHALA-2026-PE-99.json"), "utf8"));
    expect(generated.properties.umina_token_id).toBe("0.0.2002");
    expect(calls.order).toEqual(["compliance", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(process.exitCode).toBeUndefined();
  });

  test("an Umiña mint records no from_stone_ids and reads no NFT", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.messages.map((m) => m.event)).toEqual(["COMPLIANCE", "MINT"]);
    expect(calls.mirror.some((u) => u.includes("/nfts/"))).toBe(false);
    expect(calls.messages[1].from_stone_ids).toBeUndefined();
  });

  test("refuses an unknown --token and a mistyped option before reading anything", async () => {
    mockDependencies();
    await runScript(writeMetadata(), "--token", "constructor");
    expect(console.error).toHaveBeenCalledWith('   - --token must be umina or achala, got "constructor"');

    jest.resetModules();
    mockDependencies();
    await runScript(writeMetadata(), "--dryrun");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unknown option '--dryrun'"));
    expect(calls.order).toEqual([]);
  });
});
