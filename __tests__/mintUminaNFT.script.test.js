import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { PrivateKey } from "@hashgraph/sdk";

// Runs src/mintUminaNFT.js itself (it calls main() on import) with Hedera,
// Pinata (fetch) and dotenv mocked, and records what it sends.

const key = PrivateKey.generateECDSA().toStringDer();
const calls = {};

function mockDependencies({ pinStatus = 200, mintError, hcsError } = {}) {
  calls.order = [];
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
    ...jest.requireActual("@hashgraph/sdk"),
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
          return { getReceipt: async () => ({ serials: [7] }) };
        }),
      };
      return tx;
    }),
    TopicMessageSubmitTransaction: jest.fn().mockImplementation(() => {
      const tx = {
        setTopicId: jest.fn((id) => ((calls.hcs = { topicId: id }), tx)),
        setMessage: jest.fn((m) => ((calls.hcs.message = JSON.parse(m)), tx)),
        execute: jest.fn(async () => {
          calls.order.push("hcs");
          if (hcsError) throw hcsError;
          return { transactionId: { toString: () => "0.0.1@1700000000.1" } };
        }),
      };
      return tx;
    }),
  }));

  global.fetch = jest.fn(async (url, init) => {
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

async function runScript(...args) {
  process.argv = ["node", "src/mintUminaNFT.js", ...args];
  await import("../src/mintUminaNFT.js");
  // main() is not awaited by the module, so let its promises settle
  await new Promise((resolve) => setImmediate(resolve));
}

// Writes a metadata file (the example template plus a list of images) and the
// image files it names into a temp folder, and returns the metadata file path.
function writeMetadata(change = () => {}, imageNames = ["thumb.jpg", "master.jpg"], documentNames = []) {
  const metadata = JSON.parse(fs.readFileSync("json/example.json", "utf8"));
  metadata.images = imageNames.map((name) => ({ file: name, description: `${name} description` }));
  if (documentNames.length) {
    metadata.documents = documentNames.map((name) => ({ file: name, description: `${name} description` }));
  }
  change(metadata);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-"));
  [...new Set([...imageNames, ...documentNames])].forEach((name) => fs.writeFileSync(path.join(dir, name), "data"));
  const file = path.join(dir, "metadata.json");
  fs.writeFileSync(file, JSON.stringify(metadata));
  return file;
}

describe("mintUminaNFT.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  const fetchBefore = global.fetch;
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

    expect(calls.order).toEqual(["pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.close).toHaveBeenCalled();
  });

  test("pins each image with its name, MIME type and the Pinata JWT", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    expect(calls.files).toEqual([
      { name: "thumb.jpg", type: "image/jpeg", metadataName: "UMINA-2026-CH-03-thumb.jpg" },
      { name: "master.jpg", type: "image/jpeg", metadataName: "UMINA-2026-CH-03-master.jpg" },
    ]);
    expect(calls.pin.headers.authorization).toBe("Bearer test-jwt");
  });

  test("sets image and files from the pinned CIDs and drops the images list", async () => {
    mockDependencies();
    await runScript(writeMetadata());

    const pinned = calls.pin.body.pinataContent;
    expect(pinned.images).toBeUndefined();
    expect(pinned.image).toBe("ipfs://QmFile1");
    expect(pinned.type).toBe("image/jpeg");
    expect(pinned.files).toEqual([
      { uri: "ipfs://QmFile1", type: "image/jpeg", is_default_file: true, metadata: { description: "thumb.jpg description" } },
      { uri: "ipfs://QmFile2", type: "image/jpeg", is_default_file: false, metadata: { description: "master.jpg description" } },
    ]);
    expect(calls.pin.body.pinataMetadata.name).toBe("UMINA-2026-CH-03");
  });

  test("pins an image listed twice only once", async () => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, ["thumb.jpg", "thumb.jpg"]));

    expect(calls.files).toHaveLength(1);
    const pinned = calls.pin.body.pinataContent;
    expect(pinned.files.map((f) => f.uri)).toEqual(["ipfs://QmFile1", "ipfs://QmFile1"]);
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
      stone_id: "UMINA-2026-CH-03",
      actor_id: "0.0.1001",
      token_id: "0.0.2002",
      serials: ["7"],
      ipfs_cid: "QmMockCID12345",
    });
  });

  test("lists missing variables and sends nothing", async () => {
    delete process.env.PINATA_JWT;
    delete process.env.HCS_TOPIC_ID;
    mockDependencies();
    await runScript(writeMetadata());

    expect(console.error).toHaveBeenCalledWith("   - HCS_TOPIC_ID is missing");
    expect(console.error).toHaveBeenCalledWith("   - PINATA_JWT is missing");
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

  test("rejects metadata with no images", async () => {
    mockDependencies();
    await runScript(writeMetadata((m) => (m.images = []), []));

    expect(console.error).toHaveBeenCalledWith("   - images must list at least one image file");
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("lists an image file that does not exist and sends nothing", async () => {
    mockDependencies();
    const file = writeMetadata((m) => m.images.push({ file: "gone.jpg" }));
    await runScript(file);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("file not found:"));
    expect(calls.order).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run lists the images it would pin and sends nothing", async () => {
    mockDependencies();
    await runScript(writeMetadata(), "--dry-run");

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Would pin"));
    expect(log).toHaveBeenCalledWith("Dry run, nothing sent.");
    expect(calls.order).toEqual([]);
    expect(calls.forTestnet).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("does not pin the metadata or mint when an image pin fails", async () => {
    mockDependencies({ pinStatus: 401 });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["pinFile"]);
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("does not notarize when the mint fails", async () => {
    mockDependencies({ mintError: new Error("TOKEN_HAS_NO_SUPPLY_KEY") });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["pinFile", "pinFile", "pin", "mint"]);
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("reports the minted serials when HCS notarization fails", async () => {
    mockDependencies({ hcsError: new Error("TOPIC_EXPIRED") });
    await runScript(writeMetadata());

    expect(calls.order).toEqual(["pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Minted serials 7 (ipfs://QmMockCID12345)"),
      expect.any(Error),
    );
    expect(process.exitCode).toBe(1);
    expect(calls.close).toHaveBeenCalled();
  });

  test("pins documents after the images and lists them after the images in files", async () => {
    mockDependencies();
    await runScript(writeMetadata(() => {}, ["thumb.jpg"], ["receipt.pdf", "permit.pdf"]));

    expect(calls.order).toEqual(["pinFile", "pinFile", "pinFile", "pin", "mint", "hcs"]);
    expect(calls.files.map((f) => [f.name, f.type])).toEqual([
      ["thumb.jpg", "image/jpeg"],
      ["receipt.pdf", "application/pdf"],
      ["permit.pdf", "application/pdf"],
    ]);
    const pinned = calls.pin.body.pinataContent;
    expect(pinned.documents).toBeUndefined();
    expect(pinned.image).toBe("ipfs://QmFile1");
    expect(pinned.files).toEqual([
      { uri: "ipfs://QmFile1", type: "image/jpeg", is_default_file: true, metadata: { description: "thumb.jpg description" } },
      { uri: "ipfs://QmFile2", type: "application/pdf", metadata: { description: "receipt.pdf description" } },
      { uri: "ipfs://QmFile3", type: "application/pdf", metadata: { description: "permit.pdf description" } },
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
    ["thumb.jpg", "receipt.pdf"].forEach((n) => fs.writeFileSync(path.join(dir, n), "data"));
    const post = {
      name: "Stone from the form",
      description: "Posted through the mint form",
      stone_id: "UMINA-2026-CH-77",
      hs_code: "7103.99.00.00",
      jurisdiction: "Peru",
      legal_uri: "https://umina-achala.pe/",
      vendor_ruc: "20999887766",
      mining_concession: "Arequipa-Chrys-03",
      reinfo_id: "PERU-MIN-445566",
      attributes: { "Stone Type": "Chrysocolla" },
      images: [{ file: "thumb.jpg", description: "Front view" }],
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
    expect(generated.images[0].file).toBe(path.join(path.dirname(file), "thumb.jpg"));

    expect(calls.order).toEqual(["pinFile", "pinFile", "pin", "mint", "hcs"]);
    const pinned = calls.pin.body.pinataContent;
    expect(pinned.name).toBe("Stone from the form");
    expect(pinned.attributes).toEqual([{ trait_type: "Stone Type", value: "Chrysocolla" }]);
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
});
