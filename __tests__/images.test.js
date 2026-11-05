import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  fitInside,
  inspectImage,
  MAX_FILE_BYTES,
  planVersions,
  writeVersions,
} from "../src/mint/images.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umina-images-"));
const write = (name, buffer) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
};
const blank = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 160 } } });

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
      expect(await inspectImage(file, "main_image")).toMatchObject({ width: 64, height: 48 });
    }
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

describe("planVersions and writeVersions", () => {
  test("plan: a master for every photo, a display version for the main one only", () => {
    const info = { format: "png", width: 3000, height: 2000 };
    expect(planVersions({ index: 1, main: true }, info, "/g/UMINA-2026-CH-03")).toEqual({
      master: { file: "/g/UMINA-2026-CH-03/01-master.png", mime: "image/png", width: 3000, height: 2000 },
      display: { file: "/g/UMINA-2026-CH-03/01-display.jpg", mime: "image/jpeg", width: 1080, height: 720 },
    });
    expect(planVersions({ index: 2, main: false }, info, "/g/x")).toEqual({
      master: { file: "/g/x/02-master.png", mime: "image/png", width: 3000, height: 2000 },
    });
  });

  test("writes rotated versions with no EXIF or GPS, and the master's SHA-256", async () => {
    // A phone-like photo: EXIF with a camera make and GPS, turned by orientation 6
    const source = write(
      "phone.jpg",
      await blank(1600, 1200)
        .withExif({ IFD0: { Make: "TestPhone" }, IFD3: { GPSLatitudeRef: "S", GPSLongitudeRef: "W" } })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );
    expect((await sharp(source).metadata()).exif.includes("TestPhone")).toBe(true);

    const info = await inspectImage(source, "main_image");
    const planned = planVersions({ index: 1, main: true }, info, path.join(dir, "out"));
    const written = await writeVersions(source, info, planned);

    for (const version of [written.master, written.display]) {
      const meta = await sharp(version.file).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(fs.readFileSync(version.file).includes("TestPhone")).toBe(false);
    }
    // Turned upright: portrait, and the display version fits 1080 on the long side
    const master = await sharp(written.master.file).metadata();
    const display = await sharp(written.display.file).metadata();
    expect([master.width, master.height]).toEqual([1200, 1600]);
    expect([display.width, display.height]).toEqual([810, 1080]);
    expect(written.master.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("keeps the master in the upload's format and does not enlarge a small photo", async () => {
    const source = write("small.webp", await blank(500, 400).webp().toBuffer());
    const info = await inspectImage(source, "main_image");
    const written = await writeVersions(source, info, planVersions({ index: 1, main: true }, info, path.join(dir, "small")));

    expect((await sharp(written.master.file).metadata()).format).toBe("webp");
    const display = await sharp(written.display.file).metadata();
    expect([display.format, display.width, display.height]).toEqual(["jpeg", 500, 400]);
  });
});
