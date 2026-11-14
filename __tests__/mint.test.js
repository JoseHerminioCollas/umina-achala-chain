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
  parseMintArgs,
  pinFile,
  pinJson,
  testnetFolderProblem,
  validateMintEnv,
  withPlaceholderAssets,
} from "../src/mint/lib.js";
import { buildEvent, MAX_MESSAGE_BYTES } from "../src/hcs.js";
import {
  achalaSaleFields,
  achalaSalePlan,
  isBurned,
  MAX_NFT_TRANSFERS,
  mintOfSerial,
  mountedProblem,
  mountedStones,
  uminaTokenProblem,
  withUminaTokenId,
} from "../src/mint/achala.js";

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
        "UMINA_TOKEN_ID is not set",
        "PINATA_JWT is not set",
        "SUPPLY_KEY is not set",
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
  const make = () => ({
    name: "Stone",
    main_image: { file: "front.jpg", description: "Front view" },
    images: [{ file: "docs/side.PNG", description: "Side view" }],
  });

  test("collectImages reads main_image first, then images, with absolute paths", () => {
    const { images, problems } = collectImages(make(), dir);
    expect(problems).toEqual([]);
    expect(images).toEqual([
      { file: path.join(dir, "front.jpg"), description: "Front view", label: "main_image", main: true, index: 1 },
      { file: path.join(dir, "docs/side.PNG"), description: "Side view", label: "images[0]", main: false, index: 2 },
    ]);
  });

  test("collectImages needs main_image; images is optional", () => {
    expect(collectImages({}, dir).problems).toEqual([
      "main_image is required: the photo whose display version becomes `image`",
    ]);
    expect(collectImages({ main_image: { file: "a.webp" } }, dir).problems).toEqual([]);
  });

  test("collectImages names a missing file, a refused type and a repeated photo", () => {
    const { problems } = collectImages(
      {
        main_image: { file: "a.jpg" },
        images: [{}, { file: "b.gif" }, { file: "c.heic" }, { file: "d.tiff" }, { file: "a.jpg" }],
      },
      dir,
    );
    expect(problems).toEqual([
      "images[0].file is missing",
      'images[1].file "b.gif": GIF has 256 colours; upload a JPEG, PNG or WebP photo',
      'images[2].file "c.heic": HEIC (an iPhone photo) is not supported; export or share it as JPEG',
      'images[3].file "d.tiff" is not a JPEG, PNG or WebP photo',
      'images[4].file "a.jpg" is already main_image; list each photo once',
    ]);
  });

  test("collectImages allows at most 20 photos besides main_image (#35)", () => {
    const list = (n) => Array.from({ length: n }, (_, i) => ({ file: `${i}.jpg` }));
    const twenty = collectImages({ main_image: { file: "m.jpg" }, images: list(20) }, dir);
    expect(twenty.problems).toEqual([]);
    expect(twenty.images).toHaveLength(21);
    expect(collectImages({ main_image: { file: "m.jpg" }, images: list(21) }, dir).problems).toEqual([
      "images lists 21 photos; at most 20 besides main_image",
    ]);
  });

  const versions = (n, main, checksum) => ({
    master: { file: `/g/0${n}-master.jpg`, mime: "image/jpeg", ...(checksum && { checksum }) },
    ...(main && { display: { file: `/g/0${n}-display.jpg`, mime: "image/jpeg" } }),
  });
  const photos = (checksum) => [
    { main: true, description: "Front view", versions: versions(1, true, checksum) },
    { main: false, description: "Side view", versions: versions(2, false, checksum) },
  ];

  test("buildMetadata: image is the display version, files has one entry per master", () => {
    const cids = new Map([
      ["/g/01-master.jpg", "QmMaster1"],
      ["/g/01-display.jpg", "QmDisplay"],
      ["/g/02-master.jpg", "QmMaster2"],
    ]);
    const built = buildMetadata(make(), photos("ab".repeat(32)), cids);
    expect(built.main_image).toBeUndefined();
    expect(built.images).toBeUndefined();
    expect(built.image).toBe("ipfs://QmDisplay");
    expect(built.type).toBe("image/jpeg");
    expect(built.files).toEqual([
      { uri: "ipfs://QmMaster1", type: "image/jpeg", is_default_file: true, checksum: "ab".repeat(32), metadata: { description: "Front view" } },
      { uri: "ipfs://QmMaster2", type: "image/jpeg", is_default_file: false, checksum: "ab".repeat(32), metadata: { description: "Side view" } },
    ]);
  });

  test("buildMetadata uses placeholder URIs and no checksum before the files are written", () => {
    const built = buildMetadata(make(), photos());
    expect(built.image).toBe("ipfs://pending");
    expect(built.files.map((f) => [f.uri, "checksum" in f])).toEqual([
      ["ipfs://pending", false],
      ["ipfs://pending", false],
    ]);
  });

  test("buildMetadata keeps files already in the metadata and adds documents last", () => {
    const metadata = { ...make(), files: [{ uri: "ipfs://QmOld", type: "model/gltf-binary" }] };
    const documents = [{ file: "/g/permit.pdf", mime: "application/pdf", description: "Permit" }];
    const built = buildMetadata(metadata, photos(), new Map([["/g/permit.pdf", "QmPermit"]]), documents);
    expect(built.files[0]).toEqual({ uri: "ipfs://QmOld", type: "model/gltf-binary" });
    expect(built.files.at(-1)).toEqual({
      uri: "ipfs://QmPermit",
      type: "application/pdf",
      metadata: { description: "Permit" },
    });
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

describe("parseMintArgs", () => {
  test("reads the file, the options and the token class, umina by default", () => {
    expect(parseMintArgs(["m.json"])).toMatchObject({
      metadataFile: "m.json",
      outDir: "generated",
      tokenClass: "umina",
      force: false,
      dryRun: false,
      imagesOnly: false,
      problems: [],
    });
    expect(parseMintArgs(["--form", "p.json", "--token=achala", "--out", "o", "--force"])).toMatchObject({
      formFile: "p.json",
      tokenClass: "achala",
      outDir: "o",
      force: true,
      problems: [],
    });
  });

  test("lists what is wrong with the command line", () => {
    expect(parseMintArgs(["a.json", "b.json"]).problems).toEqual(["give one metadata file, got a.json, b.json"]);
    expect(parseMintArgs(["a.json", "--form", "p.json"]).problems).toEqual(["give a metadata file or --form, not both"]);
    expect(parseMintArgs(["a.json", "--token", "__proto__"]).problems).toEqual([
      '--token must be umina or achala, got "__proto__"',
    ]);
    expect(parseMintArgs(["a.json", "--token"]).problems[0]).toContain("argument missing");
  });
});

describe("minting an Achala (umina-achala-chain#16)", () => {
  test("validateMintEnv needs the Achala token, and the Umiña token and treasury to check its stones", () => {
    expect(validateMintEnv(makeEnv(), "achala")).toEqual(["ACHALA_TOKEN_ID is not set", "TREASURY_ID is not set"]);
    expect(
      validateMintEnv(makeEnv({ UMINA_TOKEN_ID: undefined, ACHALA_TOKEN_ID: "0.0.4004", TREASURY_ID: "0.0.1001" }), "achala"),
    ).toEqual(["UMINA_TOKEN_ID is not set"]);
  });

  test("checkStoneId follows the class and names the other one", () => {
    expect(checkStoneId("ACHALA-2026-RI-01", "achala")).toBeNull();
    expect(checkStoneId("ACHALA-2026-RI-01")).toContain("give --token achala");
    expect(checkStoneId("UMINA-2026-CH-03", "achala")).toContain("give --token umina");
    expect(checkStoneId("RING-1", "achala")).toBe('properties.stone_id must look like ACHALA-2026-RI-01, got "RING-1"');
  });

  test("withUminaTokenId sets umina_token_id only when it is absent", () => {
    const stones = [{ serial: 1, stone_id: "A" }];
    expect(withUminaTokenId({ properties: { stones } }, "0.0.2002").properties).toEqual({ stones, umina_token_id: "0.0.2002" });
    const typed = { properties: { stones, umina_token_id: "0.0.7" } };
    expect(withUminaTokenId(typed, "0.0.2002")).toBe(typed);
  });

  test("uminaTokenProblem refuses a token other than UMINA_TOKEN_ID", () => {
    expect(uminaTokenProblem({ umina_token_id: "0.0.2002" }, "0.0.2002")).toBeNull();
    expect(uminaTokenProblem({ umina_token_id: "0.0.7" }, "0.0.2002")).toBe(
      "properties.umina_token_id 0.0.7 is not the Umiña token 0.0.2002 (UMINA_TOKEN_ID)",
    );
  });

  test("mountedStones reads the Achalas' MINT events, ignoring other tokens and burned Achalas", () => {
    const mint = (serial, ids, token = "0.0.4004") => ({
      event: { event: "MINT", stone_id: `ACHALA-2026-RI-0${serial}`, token_id: token, serials: [serial], from_stone_ids: ids },
    });
    const events = [
      mint("1", ["UMINA-2026-CH-01", "UMINA-2026-AU-01"]),
      mint("2", ["UMINA-2026-CH-02"]),
      mint("3", ["UMINA-2026-CH-03"], "0.0.9999"),
      { event: { event: "COMPLIANCE", token_id: "0.0.4004", serials: [], from_stone_ids: ["UMINA-2026-CH-04"] } },
      { event: { event: "BURN", token_id: "0.0.4004", serials: ["2"] } },
    ];
    expect([...mountedStones(events, "0.0.4004").keys()]).toEqual(["UMINA-2026-CH-01", "UMINA-2026-AU-01"]);
  });

  test("the largest Achala MINT (9 stones) fits in one HCS message", () => {
    const ids = Array.from({ length: 9 }, (_, i) => `UMINA-2026-CH-${String(i).padStart(4, "0")}`);
    const envelope = {
      event: "MINT",
      stoneId: "ACHALA-2026-RI-0001",
      tokenId: "0.0.12345678",
      serials: ["123456"],
      actorId: "0.0.12345678",
      ref: "0.0.12345678@1700000000.123456789",
    };
    const message = buildEvent(envelope, { ipfs_cid: "bafkrei" + "a".repeat(52), from_stone_ids: ids });
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});

describe("mounted stones and Achala sales (umina-achala-chain#24, #26)", () => {
  const U = "0.0.2002";
  const A = "0.0.4004";
  const ev = (event) => ({ event });
  const stoneMint = (id, serial) => ev({ event: "MINT", stone_id: id, token_id: U, serials: [serial] });
  const achalaMint = (id, serial, stones) =>
    ev({ event: "MINT", stone_id: id, token_id: A, serials: [serial], from_stone_ids: stones });
  const events = [
    stoneMint("UMINA-2026-CH-03", "3"),
    stoneMint("UMINA-2026-AU-01", "4"),
    stoneMint("UMINA-2026-CH-05", "5"),
    achalaMint("ACHALA-2026-RI-01", "1", ["UMINA-2026-CH-03", "UMINA-2026-AU-01"]),
  ].map((e, i) => ({ ...e, sequence_number: i + 1 }));
  const ids = (serial) => ({ uminaTokenId: U, achalaTokenId: A, serial });

  test("mintOfSerial and isBurned find a serial's MINT and BURN", () => {
    expect(mintOfSerial(events, U, 4).event.stone_id).toBe("UMINA-2026-AU-01");
    expect(mintOfSerial(events, A, "4")).toBeUndefined();
    expect(isBurned(events, A, "1")).toBe(false);
    expect(isBurned([...events, ev({ event: "BURN", token_id: A, serials: ["1"] })], A, 1)).toBe(true);
  });

  test("mountedProblem names the Achala a stone is in, and is null for a free stone", () => {
    expect(mountedProblem(events, ids("3"))).toBe(
      "UMINA-2026-CH-03 (0.0.2002/3) is mounted in Achala ACHALA-2026-RI-01 (0.0.4004/1, MINT #4): " +
        "it moves only with its Achala, and is freed when the Achala is burned",
    );
    expect(mountedProblem(events, ids("5"))).toBeNull();
    expect(mountedProblem(events, ids("99"))).toBeNull();
  });

  test("mountedProblem frees the stones of a burned Achala, and checks nothing without an Achala token", () => {
    const burned = [...events, ev({ event: "BURN", token_id: A, serials: ["1"] })];
    expect(mountedProblem(burned, ids("3"))).toBeNull();
    expect(mountedProblem(events, { ...ids("3"), achalaTokenId: undefined })).toBeNull();
  });

  test("achalaSalePlan lists the Achala's stones with their Umiña serials", () => {
    expect(achalaSalePlan(events, ids("1"))).toEqual({
      achalaId: "ACHALA-2026-RI-01",
      stones: [
        { stone_id: "UMINA-2026-CH-03", serial: "3" },
        { stone_id: "UMINA-2026-AU-01", serial: "4" },
      ],
      problems: [],
    });
    expect(achalaSaleFields(achalaSalePlan(events, ids("1")).stones, U)).toEqual({
      from_stone_ids: ["UMINA-2026-CH-03", "UMINA-2026-AU-01"],
      umina_token_id: "0.0.2002",
      umina_serials: ["3", "4"],
    });
  });

  test.each([
    ["was never minted", events, "2", "Achala 0.0.4004/2 has no MINT event on the topic"],
    [
      "is burned",
      [...events, ev({ event: "BURN", token_id: A, serials: ["1"] })],
      "1",
      "Achala 0.0.4004/1 is burned (the piece was taken apart)",
    ],
    [
      "has a stone with no MINT",
      [...events, achalaMint("ACHALA-2026-PE-02", "2", ["UMINA-2026-CH-09"])],
      "2",
      "UMINA-2026-CH-09 has no MINT event in the Umiña token 0.0.2002",
    ],
    [
      "has a stone minted twice",
      [...events, stoneMint("UMINA-2026-CH-05", "6"), achalaMint("ACHALA-2026-PE-02", "2", ["UMINA-2026-CH-05"])],
      "2",
      "UMINA-2026-CH-05 was minted 2 times; sell this Achala by hand",
    ],
  ])("achalaSalePlan refuses an Achala that %s", (_, list, serial, problem) => {
    expect(achalaSalePlan(list, ids(serial)).problems).toEqual([problem]);
  });

  test("achalaSalePlan refuses a piece over the NFT transfer limit", () => {
    const many = Array.from({ length: MAX_NFT_TRANSFERS }, (_, i) => `UMINA-2026-CH-${10 + i}`);
    const list = [...many.map((id, i) => stoneMint(id, String(10 + i))), achalaMint("ACHALA-2026-NE-01", "9", many)];
    expect(achalaSalePlan(list, ids("9")).problems).toEqual([
      "Achala 0.0.4004/9 has 10 stones: one transfer moves at most 10 NFTs, the Achala and 9 stones",
    ]);
  });
});
