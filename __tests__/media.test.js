import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { ensureMedia, mediaPaths, photoUris, SIZES, webpCopy } from "../src/catalog/media.js";

// The site's copies of each photo in the catalog (umina-achala-chain#45).

const png = (width, height, alpha = 1) =>
  sharp({ create: { width, height, channels: 4, background: { r: 10, g: 120, b: 90, alpha } } }).png().toBuffer();

describe("photoUris", () => {
  test("each photo once: image, then image files, of every item and an Achala's stones; no documents", () => {
    const nft = (image, files = []) => ({ metadata: { image, files } });
    const items = [
      { ...nft("ipfs://QmA", [{ uri: "ipfs://QmA2", type: "image/png" }, { uri: "ipfs://QmPdf", type: "application/pdf" }]) },
      {
        ...nft("ipfs://QmB", [{ uri: "ipfs://QmGlb", type: "model/gltf-binary" }]),
        stones: [nft("ipfs://QmA"), nft("ipfs://QmC", [{ uri: "ipfs://QmC2", type: "image/jpeg" }])],
      },
    ];
    expect(photoUris(items)).toEqual(["ipfs://QmA", "ipfs://QmA2", "ipfs://QmB", "ipfs://QmC", "ipfs://QmC2"]);
    expect(photoUris([])).toEqual([]);
  });
});

describe("mediaPaths", () => {
  test("a folder per IPFS path, relative to catalog.json", () => {
    expect(mediaPaths("ipfs://QmA")).toEqual({ thumb: "media/QmA/thumb.webp", display: "media/QmA/display.webp" });
    expect(mediaPaths("ipfs://QmA/p.png").thumb).toBe("media/QmA/p.png/thumb.webp");
    expect(mediaPaths("https://x/y.png")).toBeNull();
    expect(mediaPaths("ipfs://QmA/../../etc")).toBeNull();
  });
});

describe("webpCopy", () => {
  test("fits inside the square, never enlarges, keeps transparency", async () => {
    const wide = await sharp(await webpCopy(await png(2000, 1000, 0.5), 400)).metadata();
    expect([wide.format, wide.width, wide.height, wide.hasAlpha]).toEqual(["webp", 400, 200, true]);
    const small = await sharp(await webpCopy(await png(100, 300), 400)).metadata();
    expect([small.width, small.height]).toEqual([100, 300]);
    expect(SIZES).toEqual({ thumb: 400, display: 1080 });
  });
});

describe("ensureMedia", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("reads the photo once and writes both copies; a second call reads nothing", async () => {
    const fetchBytes = jest.fn(async () => png(1600, 1200));
    const first = await ensureMedia(dir, "ipfs://QmA", { fetchBytes });
    expect(first).toEqual({ paths: mediaPaths("ipfs://QmA"), read: true });
    expect(fetchBytes).toHaveBeenCalledWith("QmA");
    expect(fs.readdirSync(path.join(dir, "media/QmA")).sort()).toEqual(["display.webp", "thumb.webp"]);
    const second = await ensureMedia(dir, "ipfs://QmA", { fetchBytes });
    expect(second.read).toBe(false);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  test("makes only a missing copy", async () => {
    const fetchBytes = jest.fn(async () => png(1600, 1200));
    await ensureMedia(dir, "ipfs://QmA", { fetchBytes });
    fs.rmSync(path.join(dir, "media/QmA/thumb.webp"));
    const before = fs.statSync(path.join(dir, "media/QmA/display.webp")).mtimeMs;
    await ensureMedia(dir, "ipfs://QmA", { fetchBytes });
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(dir, "media/QmA/thumb.webp"))).toBe(true);
    expect(fs.statSync(path.join(dir, "media/QmA/display.webp")).mtimeMs).toBe(before);
  });

  test("a dry run reads and writes nothing, and says whether it would read", async () => {
    const fetchBytes = jest.fn();
    await expect(ensureMedia(dir, "ipfs://QmA", { dryRun: true, fetchBytes })).resolves.toEqual({
      paths: mediaPaths("ipfs://QmA"),
      read: true,
    });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "media"))).toBe(false);
  });

  test("a URI that is not an ipfs:// path, or a file that is not an image, throws and leaves no file", async () => {
    await expect(ensureMedia(dir, "https://x/p.png")).rejects.toThrow("is not an ipfs:// path");
    await expect(ensureMedia(dir, "ipfs://QmBad", { fetchBytes: async () => Buffer.from("<html>") })).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "media/QmBad/thumb.webp"))).toBe(false);
  });
});
