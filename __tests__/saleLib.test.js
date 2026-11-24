import { jest } from "@jest/globals";
import { Hbar, NftId, TokenId } from "@hashgraph/sdk";
import { recordSold, saleChecks } from "../src/sale/lib.js";
import { buyerAccount } from "../src/mirror.js";

// The parts of a sale the command line and umina-achala-server share
// (umina-achala-web#116): what follows a settled sale, and the buyer check.

const reply = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => "" });
const MIRROR = "https://testnet.mirrornode.hedera.com";

describe("recordSold", () => {
  const env = { HCS_TOPIC_ID: "0.0.3003", HCS_DISPLAY_TOPIC_ID: "0.0.3004" };
  const sale = { uaId: "0.0.1001", treasuryId: "0.0.1002", buyerId: "0.0.6006", price: new Hbar(45), saleTxId: "0.0.1001@1.1" };
  const plan = (extra = {}) => ({
    tokenClass: "umina",
    tokenId: TokenId.fromString("0.0.2002"),
    nftId: new NftId(TokenId.fromString("0.0.2002"), 15),
    stoneId: "UMINA-2026-AG-01",
    stones: [],
    uminaTokenId: null,
    ...extra,
  });

  test("SALE on the provenance topic, then UNLISTED (sold) on the display topic", async () => {
    const submit = jest.fn(async (client, topic) => `tx-${topic}`);
    const out = await recordSold("client", env, sale, plan(), { submit });
    expect(out).toEqual({ saleEventTxId: "tx-0.0.3003", unlistedTxId: "tx-0.0.3004", problems: [] });
    const [[, t1, sold], [, t2, unlisted]] = submit.mock.calls;
    expect([t1, sold.event, sold.ref, sold.buyer_id, sold.sold_for]).toEqual(["0.0.3003", "SALE", "0.0.1001@1.1", "0.0.6006", "45"]);
    expect([t2, unlisted.event, unlisted.stone_id, unlisted.serials, unlisted.reason]).toEqual([
      "0.0.3004",
      "UNLISTED",
      "UMINA-2026-AG-01",
      ["15"],
      "sold",
    ]);
  });

  test("never throws: each failed step says how to record it by hand", async () => {
    const submit = jest.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce("tx-2");
    let out = await recordSold("client", env, sale, plan(), { submit });
    expect(out.unlistedTxId).toBe("tx-2");
    expect(out.problems).toEqual([expect.stringMatching(/^SALE was not recorded \(busy\); record it by hand/)]);
    const failing = jest.fn().mockRejectedValue(new Error("down"));
    const achala = plan({ tokenClass: "achala", tokenId: TokenId.fromString("0.0.2003"), nftId: new NftId(TokenId.fromString("0.0.2003"), 6), achalaId: "ACHALA-2026-PE-02", stoneId: "ACHALA-2026-PE-02", stones: [{ stone_id: "UMINA-2026-AU-01", serial: "19" }], uminaTokenId: TokenId.fromString("0.0.2002") });
    out = await recordSold("client", env, sale, achala, { submit: failing });
    expect(out.problems[1]).toBe("UNLISTED was not posted (down); post it by hand: displayEvent.js unlisted 6 --token achala --reason sold");
  });
});

describe("buyerAccount", () => {
  const key = { _type: "ED25519", key: "ab" };
  const route = (routes) =>
    jest.fn(async (url) => {
      const path = url.replace(MIRROR, "");
      for (const [prefix, body] of routes) if (path.startsWith(prefix)) return body === 404 ? reply(404, {}) : reply(200, body);
      return reply(404, {});
    });

  test("associated tokens, unlimited automatic associations, and free automatic slots pass", async () => {
    const fetchFn = route([
      ["/api/v1/accounts/0.0.6006/tokens?token.id=0.0.2002", { tokens: [{ token_id: "0.0.2002" }] }],
      ["/api/v1/accounts/0.0.6006/tokens?token.id=", { tokens: [] }],
      ["/api/v1/accounts/0.0.6006/tokens?limit", { tokens: [{ automatic_association: true }], links: { next: null } }],
      ["/api/v1/accounts/0.0.6006", { key, max_automatic_token_associations: 2, balance: { balance: 2500000000 } }],
    ]);
    // 0.0.2002 associated; 0.0.2003 takes the second automatic slot; the balance in tinybars
    expect(await buyerAccount("0.0.6006", ["0.0.2002", "0.0.2003"], fetchFn)).toEqual({
      key,
      notAssociated: [],
      balance: 2500000000,
    });
  });

  test("lists the tokens the account cannot receive; null for a missing account", async () => {
    const full = route([
      ["/api/v1/accounts/0.0.6006/tokens?token.id=", { tokens: [] }],
      ["/api/v1/accounts/0.0.6006/tokens?limit", { tokens: [{ automatic_association: true }], links: { next: null } }],
      ["/api/v1/accounts/0.0.6006", { key, max_automatic_token_associations: 1 }],
    ]);
    expect(await buyerAccount("0.0.6006", ["0.0.2002"], full)).toEqual({ key, notAssociated: ["0.0.2002"], balance: null });
    const unlimited = route([
      ["/api/v1/accounts/0.0.6006/tokens", { tokens: [] }],
      ["/api/v1/accounts/0.0.6006", { key, max_automatic_token_associations: -1 }],
    ]);
    expect((await buyerAccount("0.0.6006", ["0.0.2002"], unlimited)).notAssociated).toEqual([]);
    expect(await buyerAccount("0.0.6006", ["0.0.2002"], route([]))).toBeNull();
  });
});

describe("saleChecks", () => {
  const plan = {
    tokenClass: "umina",
    tokenId: TokenId.fromString("0.0.2002"),
    nftId: new NftId(TokenId.fromString("0.0.2002"), 7),
    nftIds: [new NftId(TokenId.fromString("0.0.2002"), 7)],
    stoneId: "UMINA-2026-QZ-01",
  };
  const env = { TREASURY_ID: "0.0.1001", HCS_DISPLAY_TOPIC_ID: "0.0.3004" };
  const buyer = async () => ({ key: null, notAssociated: [], balance: 1000 * 1e8 });
  const listed = async () => ({
    events: [{ sequence_number: 1, event: { event: "LISTED", token_id: "0.0.2002", serials: ["7"], price: "100" } }],
  });
  const arrival = async () => null;

  test("a listed item at its price, and a buyer who can pay: nothing to say", async () => {
    const out = await saleChecks(env, plan, { buyerId: "0.0.6006", price: Hbar.fromString("100") }, {
      display: listed,
      arrival,
      account: buyer,
    });
    expect(out).toEqual({ problems: [], warnings: [], listed: true });
  });

  test("an unreadable display topic is a warning, and UNLISTED is still posted (listed is null)", async () => {
    const out = await saleChecks(env, plan, { buyerId: "0.0.6006", price: Hbar.fromString("100") }, {
      display: async () => ({ problem: "cannot read HCS_DISPLAY_TOPIC_ID 0.0.3004: down" }),
      arrival,
      account: buyer,
    });
    expect(out).toEqual({
      problems: [],
      warnings: ["the listing was not checked (cannot read HCS_DISPLAY_TOPIC_ID 0.0.3004: down)"],
      listed: null,
    });
  });

  test("a mirror node error on the buyer is a problem", async () => {
    const out = await saleChecks(env, plan, { buyerId: "0.0.6006", price: Hbar.fromString("100") }, {
      display: listed,
      arrival,
      account: async () => {
        throw new Error("mirror node request failed: 500");
      },
    });
    expect(out.problems).toEqual(["cannot check the buyer's account 0.0.6006 (mirror node request failed: 500)"]);
  });

  test("a price of one tinybar is written in full", async () => {
    const out = await saleChecks(env, plan, { buyerId: "0.0.6006", price: Hbar.fromString("0.00000001") }, {
      display: listed,
      arrival,
      account: buyer,
    });
    expect(out.warnings).toEqual([
      "UMINA-2026-QZ-01 (0.0.2002/7) is listed on the site at 100 HBAR; this sale is for 0.00000001 HBAR",
    ]);
  });
});
