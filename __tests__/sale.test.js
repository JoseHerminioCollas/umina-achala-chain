import { jest } from "@jest/globals";
import { NftId, TokenId } from "@hashgraph/sdk";
import { holderProblems, readHolders } from "../src/nfts.js";

// Who holds the NFTs a sale or consignment moves, from the mirror node
// (umina-achala-chain#28, #34)
const ids = [new NftId(TokenId.fromString("0.0.4004"), 1), new NftId(TokenId.fromString("0.0.2002"), 3)];
const treasury = "0.0.1001";

describe("holderProblems", () => {
  test("nothing when the holder holds every NFT", () => {
    const held = { account_id: treasury, deleted: false };
    expect(holderProblems(ids, [held, held], treasury)).toEqual([]);
  });

  test("names each NFT that is missing, burned or held by another account", () => {
    expect(holderProblems(ids, [null, { account_id: null, deleted: true }], treasury)).toEqual([
      "0.0.4004/1 is not on the mirror node. Check the serial.",
      "0.0.2002/3 is burned. Remove the listing.",
    ]);
    expect(holderProblems(ids, [{ account_id: treasury }, { account_id: "0.0.7007" }], treasury)).toEqual([
      "0.0.2002/3 is held by 0.0.7007, not the Treasury 0.0.1001. Remove the listing.",
    ]);
  });

  test("says who the holder is and what to do", () => {
    const words = { holder: "the merchant", then: "Nothing to end." };
    expect(holderProblems(ids.slice(0, 1), [{ account_id: "0.0.6006" }], "0.0.4040", words)).toEqual([
      "0.0.4004/1 is held by 0.0.6006, not the merchant 0.0.4040. Nothing to end.",
    ]);
  });
});

describe("readHolders", () => {
  test("reads every NFT from the mirror node at once, in order", async () => {
    const fetchFn = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ account_id: url.endsWith("/nfts/1") ? "0.0.1" : "0.0.3" }),
    }));
    expect(await readHolders(ids, fetchFn)).toEqual([{ account_id: "0.0.1" }, { account_id: "0.0.3" }]);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.4004/nfts/1",
      "https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.2002/nfts/3",
    ]);
  });
});
