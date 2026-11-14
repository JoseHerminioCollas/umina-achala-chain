/**
 * @file config/achala.js
 * @description The Achala token class: a piece of jewelry made of one or more
 * Umiña stones (umina-achala-chain#15, #16, #34). The stones keep their own
 * Umiña NFTs and move with the piece. Its ID is in ACHALA_TOKEN_ID in the
 * network's env file.
 */

import schema from "../schema/hip412-achala-schema.json" with { type: "json" };

export default {
  /** Token name, symbol and memo, set at creation. */
  name: "Achala",
  symbol: "ACHALA",
  memo: "Achala: Peruvian jewelry made of Umiña stones",
  /** The env variable that holds the token ID. */
  envVar: "ACHALA_TOKEN_ID",
  /**
   * properties.stone_id is <idPrefix>-YYYY-XX-NN, XX the piece type code:
   * ACHALA-2026-RI-01 is the first ring of 2026.
   */
  idPrefix: "ACHALA",
  idExample: "ACHALA-2026-RI-01",
  /** The HIP-412 metadata schema (schema/hip412-achala-schema.json). */
  schema,
  /** The metadata a mint form post starts from (mintNFT.js --form). */
  template: "json/achala-template.json",
};
