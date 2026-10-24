import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildMetadata,
  checkStoneId,
  collectDocuments,
  collectImages,
  missingAssets,
  pinFile,
  pinJson,
  samplesFolderProblem,
  validateMintEnv,
  withPlaceholderAssets,
} from "../src/mintUmina.js";

const key = PrivateKey.generateECDSA().toStringDer();

function makeEnv(overrides = {}) {
  return {
    OPERATOR_ID: "0.0.1001",
    OPERATOR_KEY: key,
    SUPPLY_KEY: key,
    UMINA_TOKEN_ID: "0.0.2002",
    HCS_TOPIC_ID: "0.0.3003",
    PINATA_JWT: "jwt",
    ...overrides,
  };
}

describe("validateMintEnv", () => {
  test("accepts a complete environment", () => {
    expect(validateMintEnv(makeEnv())).toEqual([]);
  });

  test("names each missing variable", () => {
    const env = makeEnv();
    delete env.UMINA_TOKEN_ID;
    delete env.PINATA_JWT;
    delete env.SUPPLY_KEY;
    expect(validateMintEnv(env)).toEqual(
      expect.arrayContaining([
        "UMINA_TOKEN_ID is missing",
        "PINATA_JWT is missing",
        "SUPPLY_KEY is missing",
      ]),
    );
  });

  test("rejects ids that are not 0.0.N", () => {
    const problems = validateMintEnv(makeEnv({ HCS_TOPIC_ID: "topic" }));
    expect(problems.join()).toMatch(/HCS_TOPIC_ID must look like 0\.0\.1234/);
  });

  test("rejects an ED25519 supply key", () => {
    const ed = PrivateKey.generateED25519().toStringDer();
    expect(validateMintEnv(makeEnv({ SUPPLY_KEY: ed }))).toContain(
      "SUPPLY_KEY is not an ECDSA private key (hex or DER)",
    );
  });
});

describe("checkStoneId", () => {
  test.each(["UMINA-2026-CH-03", "UMINA-2027-QZ-120"])("accepts %s", (id) => {
    expect(checkStoneId(id)).toBeNull();
  });

  test.each([
    "UMINA-000124",
    "UMINA-2026-ch-03",
    "UMINA-2026-CH-3",
    "Chrysocolla-2026-05-10T12:00:00Z",
    "",
    undefined,
  ])("rejects %s", (id) => {
    expect(checkStoneId(id)).toMatch(/must look like UMINA-2026-CH-03/);
  });
});

describe("pinJson", () => {
  test("posts the JSON with the bearer token and returns the CID", async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => ({ IpfsHash: "QmCid" }),
    }));

    await expect(pinJson({ a: 1 }, "stone", "jwt", fetchFn)).resolves.toBe("QmCid");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.pinata.cloud/pinning/pinJSONToIPFS");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer jwt");
    expect(JSON.parse(init.body)).toEqual({
      pinataContent: { a: 1 },
      pinataMetadata: { name: "stone" },
    });
  });

  test("throws with the status and body when Pinata refuses", async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 403,
      text: async () => "NO_SCOPES_FOUND",
    });

    await expect(pinJson({}, "stone", "jwt", fetchFn)).rejects.toThrow(
      "Pinata pin failed: 403 NO_SCOPES_FOUND",
    );
  });
});

describe("images", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-assets-"));
  fs.writeFileSync(path.join(dir, "thumb.jpg"), "jpg");
  const make = () => ({
    name: "Stone",
    images: [
      { file: "thumb.jpg", description: "Front view" },
      { file: "docs/side.PNG", description: "Side view" },
    ],
  });

  test("collectImages resolves paths against the base dir and sets MIME types", () => {
    const { images, problems } = collectImages(make(), dir);
    expect(problems).toEqual([]);
    expect(images).toEqual([
      { file: path.join(dir, "thumb.jpg"), description: "Front view", mime: "image/jpeg" },
      { file: path.join(dir, "docs/side.PNG"), description: "Side view", mime: "image/png" },
    ]);
  });

  test("collectImages needs at least one image", () => {
    expect(collectImages({}, dir).problems).toEqual(["images must list at least one image file"]);
    expect(collectImages({ images: [] }, dir).problems).toHaveLength(1);
  });

  test("collectImages names an entry with no file or an unsupported type", () => {
    const { problems } = collectImages({ images: [{ description: "x" }, { file: "a.pdf" }] }, dir);
    expect(problems).toEqual([
      "images[0].file is missing",
      'images[1].file "a.pdf" is not a supported image type',
    ]);
  });

  test("missingAssets reports files that do not exist", () => {
    const { images } = collectImages(make(), dir);
    expect(missingAssets(images).map((a) => a.file)).toEqual([path.join(dir, "docs/side.PNG")]);
  });

  test("samplesFolderProblem fails when images point into a samples folder that does not exist", () => {
    const { images } = collectImages({ images: [{ file: "../samples/thumb.jpg" }] }, path.join(dir, "json"));
    const samples = path.join(dir, "samples");

    expect(samplesFolderProblem(images, samples)).toMatch(/samples is missing/);
    fs.mkdirSync(samples);
    expect(samplesFolderProblem(images, samples)).toBeNull();
  });

  test("samplesFolderProblem ignores the folder when no image is inside it", () => {
    const { images } = collectImages(make(), dir);
    expect(samplesFolderProblem(images, path.join(dir, "no-such-samples"))).toBeNull();
  });

  test("buildMetadata sets image, type and one files entry per image from the CIDs", () => {
    const metadata = make();
    const { images } = collectImages(metadata, dir);
    const cids = new Map([[images[0].file, "QmThumb"], [images[1].file, "QmSide"]]);
    const built = buildMetadata(metadata, images, cids);

    expect(built.images).toBeUndefined();
    expect(built.image).toBe("ipfs://QmThumb");
    expect(built.type).toBe("image/jpeg");
    expect(built.files).toEqual([
      { uri: "ipfs://QmThumb", type: "image/jpeg", is_default_file: true, metadata: { description: "Front view" } },
      { uri: "ipfs://QmSide", type: "image/png", is_default_file: false, metadata: { description: "Side view" } },
    ]);
    // the input is left as it was
    expect(metadata.images).toHaveLength(2);
  });

  test("buildMetadata uses placeholder URIs until the CIDs exist", () => {
    const { images } = collectImages(make(), dir);
    const built = buildMetadata(make(), images);
    expect(built.image).toBe("ipfs://pending");
    expect(built.files.map((f) => f.uri)).toEqual(["ipfs://pending", "ipfs://pending"]);
  });

  test("buildMetadata keeps files already in the metadata and an existing image", () => {
    const metadata = { ...make(), image: "ipfs://QmOwn", files: [{ uri: "ipfs://QmDoc", type: "application/pdf" }] };
    const { images } = collectImages(metadata, dir);
    const built = buildMetadata(metadata, images);
    expect(built.image).toBe("ipfs://QmOwn");
    expect(built.files[0]).toEqual({ uri: "ipfs://QmDoc", type: "application/pdf" });
    expect(built.files).toHaveLength(3);
  });

  test("withPlaceholderAssets fills image and files and drops images and documents", () => {
    const metadata = { ...make(), documents: [{ file: "r.pdf" }] };
    expect(withPlaceholderAssets(metadata)).toEqual({ name: "Stone", image: "ipfs://pending", files: [] });
  });

  test("collectDocuments is optional and sets MIME types", () => {
    expect(collectDocuments({}, dir)).toEqual({ documents: [], problems: [] });
    const { documents } = collectDocuments(
      { documents: [{ file: "r.PDF", description: "Receipt" }, { file: "scan.glb" }] },
      dir,
    );
    expect(documents).toEqual([
      { file: path.join(dir, "r.PDF"), description: "Receipt", mime: "application/pdf" },
      { file: path.join(dir, "scan.glb"), description: "", mime: "model/gltf-binary" },
    ]);
  });

  test("collectDocuments names an entry with no file or an unsupported type", () => {
    const { problems } = collectDocuments({ documents: [{}, { file: "a.jpg" }] }, dir);
    expect(problems).toEqual([
      "documents[0].file is missing",
      'documents[1].file "a.jpg" is not a supported document type (pdf, glb)',
    ]);
  });

  test("buildMetadata adds documents after the images, none of them default", () => {
    const metadata = make();
    const { images } = collectImages(metadata, dir);
    const { documents } = collectDocuments({ documents: [{ file: "r.pdf", description: "Receipt" }] }, dir);
    const cids = new Map([[images[0].file, "QmThumb"], [images[1].file, "QmSide"], [documents[0].file, "QmReceipt"]]);
    const built = buildMetadata(metadata, images, cids, documents);

    expect(built.files.map((f) => f.uri)).toEqual(["ipfs://QmThumb", "ipfs://QmSide", "ipfs://QmReceipt"]);
    expect(built.files[2]).toEqual({ uri: "ipfs://QmReceipt", type: "application/pdf", metadata: { description: "Receipt" } });
  });
});

describe("pinFile", () => {
  const file = path.join(os.tmpdir(), "umina-pinfile.jpg");
  fs.writeFileSync(file, "jpg-bytes");

  test("posts the file as multipart with the bearer token and returns the CID", async () => {
    const fetchFn = jest.fn(async () => ({
      ok: true,
      json: async () => ({ IpfsHash: "QmFile" }),
    }));

    await expect(pinFile(file, "stone-thumb", "image/jpg", "jwt", fetchFn)).resolves.toBe("QmFile");

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.pinata.cloud/pinning/pinFileToIPFS");
    expect(init.headers.authorization).toBe("Bearer jwt");
    expect(init.body.get("file").name).toBe("umina-pinfile.jpg");
    expect(init.body.get("file").type).toBe("image/jpg");
    expect(JSON.parse(init.body.get("pinataMetadata"))).toEqual({ name: "stone-thumb" });
  });

  test("throws with the status and body when Pinata refuses", async () => {
    const fetchFn = async () => ({ ok: false, status: 413, text: async () => "TOO_LARGE" });
    await expect(pinFile(file, "stone-thumb", "image/jpg", "jwt", fetchFn)).rejects.toThrow(
      "Pinata file pin failed for stone-thumb: 413 TOO_LARGE",
    );
  });
});
