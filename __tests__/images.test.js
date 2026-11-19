import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  fitInside,
  inspectImage,
  MAX_FILE_BYTES,
  planVersion,
  writeVersion,
} from "../src/mint/images.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-images-"));
const write = (name, buffer) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
};
const blank = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 160 } } });
// A cut-out photo: a coloured square in the middle of a transparent background
const cutOut = async (width, height) =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await blank(Math.round(width / 2), Math.round(height / 2)).png().toBuffer(), gravity: "centre" }])
    .png();

describe("fitInside", () => {
  test("shrinks the long side to the limit and never enlarges", () => {
    expect(fitInside(4000, 3000, 1080)).toEqual({ width: 1080, height: 810 });
    expect(fitInside(3000, 4000, 1080)).toEqual({ width: 810, height: 1080 });
    expect(fitInside(800, 600, 1080)).toEqual({ width: 800, height: 600 });
  });
});

describe("inspectImage", () => {
  test("reads JPEG, PNG and WebP from the file header", async () => {
    for (const [name, encode] of [
      ["a.jpg", (s) => s.jpeg()],
      ["a.png", (s) => s.png()],
      ["a.webp", (s) => s.webp()],
    ]) {
      const file = write(name, await encode(blank(64, 48)).toBuffer());
      expect(await inspectImage(file, "main_image")).toMatchObject({ width: 64, height: 48, hasAlpha: false });
    }
  });

  test("tells whether the photo has transparency", async () => {
    const file = write("cut-out.png", await (await cutOut(64, 48)).toBuffer());
    expect(await inspectImage(file, "main_image")).toMatchObject({ format: "png", hasAlpha: true });
  });

  test("goes by the real type, not the extension", async () => {
    const gif = write("really-a-gif.jpg", await blank(8, 8).gif().toBuffer());
    expect((await inspectImage(gif, "images[0]")).problem).toBe(
      "images[0] is gif; only JPEG, PNG and WebP are accepted",
    );
    const heif = write("really-heif.jpg", await blank(8, 8).avif().toBuffer());
    expect((await inspectImage(heif, "main_image")).problem).toBe(
      "main_image is HEIC (an iPhone photo); export or share it as JPEG and upload that",
    );
    const text = write("notes.jpg", "not a photo");
    expect((await inspectImage(text, "main_image")).problem).toBe(
      "main_image is not an image sharp can read (JPEG, PNG or WebP)",
    );
  });

  test("refuses a file over 25 MB before reading it", async () => {
    const big = write("big.jpg", Buffer.alloc(MAX_FILE_BYTES + 1));
    expect((await inspectImage(big, "main_image")).problem).toBe(
      "main_image is 25.0 MB; the limit is 25 MB",
    );
  });

  test("swaps the sides of a photo the EXIF orientation turns a quarter", async () => {
    const turned = write("turned.jpg", await blank(400, 300).withMetadata({ orientation: 6 }).jpeg().toBuffer());
    expect(await inspectImage(turned, "main_image")).toMatchObject({ width: 300, height: 400 });
  });
});

describe("planVersion and writeVersion (#42)", () => {
  test("plan: a PNG for a photo with transparency, a JPEG otherwise, at most 1600 px", () => {
    expect(planVersion({ index: 1 }, { hasAlpha: true, width: 3000, height: 2000 }, "/g/UMINA-2026-CH-03")).toEqual({
      file: "/g/UMINA-2026-CH-03/01.png",
      mime: "image/png",
      width: 1600,
      height: 1067,
    });
    expect(planVersion({ index: 2 }, { hasAlpha: false, width: 800, height: 600 }, "/g/x")).toEqual({
      file: "/g/x/02.jpg",
      mime: "image/jpeg",
      width: 800,
      height: 600,
    });
  });

  test("keeps the transparency: a cut-out stays a PNG with clear corners, smaller than lossless", async () => {
    const source = write("cut-out-big.png", await (await cutOut(2400, 1800)).toBuffer());
    const info = await inspectImage(source, "main_image");
    const written = await writeVersion(source, planVersion({ index: 1 }, info, path.join(dir, "cut")));

    const meta = await sharp(written.file).metadata();
    expect([meta.format, meta.width, meta.height, meta.hasAlpha]).toEqual(["png", 1600, 1200, true]);
    // The corner pixel is still fully transparent (a JPEG would have made it black)
    const corner = await sharp(written.file).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0);
    const lossless = await sharp(source).resize(1600, 1600, { fit: "inside" }).png().toBuffer();
    expect(fs.statSync(written.file).size).toBeLessThan(lossless.length);
    expect(written.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("writes a rotated file with no EXIF or GPS", async () => {
    // A phone-like photo: EXIF with a camera make and GPS, turned by orientation 6
    const source = write(
      "phone.jpg",
      await blank(2000, 1500)
        .withExif({ IFD0: { Make: "TestPhone" }, IFD3: { GPSLatitudeRef: "S", GPSLongitudeRef: "W" } })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    expect((await sharp(source).metadata()).exif.includes("TestPhone")).toBe(true);

    const info = await inspectImage(source, "main_image");
    const written = await writeVersion(source, planVersion({ index: 1 }, info, path.join(dir, "out")));

    const meta = await sharp(written.file).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(fs.readFileSync(written.file).includes("TestPhone")).toBe(false);
    // Turned upright: portrait, 1600 on the long side
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 1200, 1600]);
  });

  test("does not enlarge a small photo; an opaque WebP becomes a JPEG", async () => {
    const source = write("small.webp", await blank(500, 400).webp().toBuffer());
    const info = await inspectImage(source, "main_image");
    const written = await writeVersion(source, planVersion({ index: 1 }, info, path.join(dir, "small")));

    const meta = await sharp(written.file).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 500, 400]);
  });
});
