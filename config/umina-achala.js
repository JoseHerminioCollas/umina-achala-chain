/**
 * @file config/umina-achala.js
 * @description Umiña Achala's own values, shared by both token classes and
 * both networks (umina-achala-chain#34). Secrets and Hedera IDs are not here:
 * they stay in .env.testnet and .env.mainnet.
 *
 * The token and topic values below are already on testnet (#22). Changing a
 * name, memo or the royalty here changes only tokens and topics created after.
 */

export default {
  /** The project's name, in topic memos and in messages. */
  name: "Umiña Achala",

  /**
   * The token's royalty on resales, paid to the treasury (UA). Set on both
   * token classes at creation; adminToken.js fees can change it later (#21).
   */
  royalty: { numerator: 5, denominator: 100 },

  /**
   * UA's commission on a consigned sale through UA's site, in basis points
   * (30.00%). It includes the royalty: the merchant ends with 70%
   * (umina-achala-web#90, decided 2026-11-09; chain#30).
   */
  commissionBps: 3000n,

  /**
   * The most the operator will pay to create a token, in HBAR. Creating a
   * token with custom fees costs about USD 2, charged in HBAR at the network's
   * rate of the hour. The SDK's default cap for a token creation is 30 HBAR,
   * which is below USD 2 once HBAR is under about 6.7 cents, and the network
   * then refuses the transaction with INSUFFICIENT_TX_FEE (testnet,
   * 2026-11-10, at 6.54 cents). 50 HBAR covers USD 2 down to 4 cents. It is a
   * ceiling only: the network charges the actual fee.
   */
  maxCreateFeeHbar: 50,

  /**
   * The two HCS topics (#9, #10): the env variable that holds each ID, and its
   * memo. Provenance holds MINT, SALE and the item's other history; display
   * holds what the site shows and what is for sale.
   */
  topics: {
    provenance: { envVar: "HCS_TOPIC_ID", memo: "Umiña Achala provenance" },
    display: { envVar: "HCS_DISPLAY_TOPIC_ID", memo: "Umiña Achala display" },
  },

  /**
   * Uploaded photos and the versions pinned from them (#7). Masters keep the
   * upload's size and format (JPEG and WebP at masterQuality, PNG lossless);
   * the main photo also gets a display version, displaySize px on the long
   * side, JPEG at displayQuality.
   *
   * maxOtherImages: photos besides main_image, 20 (#35). More than a stone
   * needs, but metadata is immutable, so a photo left out at the mint can
   * never be added to the NFT (only to HCS, #36). No total size per stone:
   * only UA uploads, and each photo is limited to maxFileBytes.
   */
  images: {
    maxFileBytes: 25 * 1024 * 1024,
    maxPixels: 100_000_000,
    maxOtherImages: 20,
    displaySize: 1080,
    masterQuality: 95,
    displayQuality: 82,
  },
};
