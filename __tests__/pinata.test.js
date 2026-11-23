import { jest } from "@jest/globals";
import { cidOf, mapLimit, nftCids, orphanCids, PINATA_UNPIN, unpin } from "../src/pinata/lib.js";

describe("CIDs of an NFT", () => {
  test("cidOf takes ipfs://<cid> and ipfs://<cid>/<file>", () => {
    expect(cidOf("ipfs://QmA")).toBe("QmA");
    expect(cidOf("ipfs://QmA/photo.png")).toBe("QmA");
    expect(cidOf("https://example.com/x.png")).toBeNull();
    expect(cidOf(undefined)).toBeNull();
  });

  test("nftCids: the metadata file, image and files, once each", () => {
    const metadata = {
      image: "ipfs://QmImage",
      files: [{ uri: "ipfs://QmImage" }, { uri: "ipfs://QmPdf" }, { uri: "https://x" }, {}],
    };
    expect(nftCids("QmMeta", metadata)).toEqual(["QmMeta", "QmImage", "QmPdf"]);
  });

  test("nftCids: only the metadata file when the metadata is unknown", () => {
    expect(nftCids("QmMeta", null)).toEqual(["QmMeta"]);
    expect(nftCids(null, null)).toEqual([]);
  });
});

describe("orphanCids", () => {
  test("keeps every CID an existing NFT uses", () => {
    const nfts = [
      { label: "Umiña #9", deleted: true, cids: ["QmOldMeta", "QmOldImage", "QmPdf"] },
      { label: "Achala #5", deleted: true, cids: ["QmAchalaMeta", "QmOldImage"] },
      { label: "Umiña #19", deleted: false, cids: ["QmNewMeta", "QmNewImage", "QmPdf"] },
    ];
    expect(orphanCids(nfts)).toEqual([
      { cid: "QmOldMeta", nfts: ["Umiña #9"] },
      { cid: "QmOldImage", nfts: ["Umiña #9", "Achala #5"] },
      { cid: "QmAchalaMeta", nfts: ["Achala #5"] },
    ]);
  });

  test("nothing when no NFT is burned", () => {
    expect(orphanCids([{ label: "Umiña #1", deleted: false, cids: ["QmA"] }])).toEqual([]);
  });
});

describe("Pinata unpin", () => {
  const reply = (status, text) => ({ ok: status === 200, status, text: async () => text });

  test("sends DELETE for the CID with a timeout", async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, "OK"));
    await expect(unpin("QmA", "jwt", fetchFn)).resolves.toBe("unpinned");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${PINATA_UNPIN}/QmA`);
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer jwt");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a CID the account does not pin is reported, not thrown", async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(400, '{"error":{"reason":"CURRENT_USER_HAS_NOT_PINNED_CID"}}'));
    await expect(unpin("QmA", "jwt", fetchFn)).resolves.toBe("not pinned");
  });

  test("any other failure throws with Pinata's answer", async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(403, '{"error":{"reason":"NO_SCOPES_FOUND"}}'));
    await expect(unpin("QmA", "jwt", fetchFn)).rejects.toThrow("403");
  });

  test("a call that hangs is given up", async () => {
    const fetchFn = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    await expect(unpin("QmA", "jwt", fetchFn, 20)).rejects.toThrow();
  });
});

describe("mapLimit", () => {
  test("keeps the order and runs at most `limit` at once", async () => {
    let running = 0;
    let most = 0;
    const result = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i * 10;
    });
    expect(result).toEqual([0, 10, 20, 30, 40]);
    expect(most).toBe(2);
  });

  test("an empty list gives an empty result", async () => {
    await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
  });
});
