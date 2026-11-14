/**
 * @file config/umina.js
 * @description The Umiña token class: a stone (umina-achala-chain#15, #34).
 * Each Umiña NFT is one stone, with its provenance in the metadata and in
 * HCS. Its ID is in UMINA_TOKEN_ID in the network's env file.
 */

import schema from "../schema/hip412-umina-schema.json" with { type: "json" };

export default {
  /** Token name, symbol and memo, set at creation. */
  name: "Umiña",
  symbol: "UMINA",
  memo: "Umiña: Peruvian stones",
  /** The env variable that holds the token ID. */
  envVar: "UMINA_TOKEN_ID",
  /**
   * properties.stone_id is <idPrefix>-YYYY-XX-NN, XX the stone type code:
   * UMINA-2026-CH-03 is the third chrysocolla of 2026.
   */
  idPrefix: "UMINA",
  idExample: "UMINA-2026-CH-03",
  /** The HIP-412 metadata schema (schema/hip412-umina-schema.json). */
  schema,
  /** The metadata a mint form post starts from (mintNFT.js --form). */
  template: "json/umina-template.json",
};
