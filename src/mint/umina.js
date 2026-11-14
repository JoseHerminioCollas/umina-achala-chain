/**
 * @file mint/umina.js
 * @description What minting an Umiña (a stone) does at each step that differs
 * by token class (umina-achala-chain#34). mintNFT.js runs these steps for
 * --token umina; achala.js has the same steps for an Achala (`mintSteps`).
 *
 * - fill(metadata, env): values the mint fills in before checking
 * - inputProblems(metadata, env, options): checks that need no network
 * - checkLedger(metadata, events, env, tokenId): checks against the ledger,
 *   before anything is sent; returns { problems, context, message }
 * - withAttributes(metadata, context): the attributes wallets show
 * - complianceFields(properties): the COMPLIANCE event's own fields
 * - mintFields(metadata): extra fields of the MINT event
 * - mintFailureNote(metadata): what else to say when MINT fails after the mint
 */

import { withStoneTypeAttributes } from "./stoneTypes.js";

export const mintSteps = {
  fill: (metadata) => metadata,

  inputProblems: () => [],

  /** A stone depends on no other NFT, so there is nothing to check. */
  checkLedger: async () => ({ problems: [], context: {} }),

  /** Stone Type, Materials and Form, from schema/stone-types.json. */
  withAttributes: (metadata) => withStoneTypeAttributes(metadata),

  /** Stone type, seller's RUC, mining concession, REINFO and HS code. */
  complianceFields: (properties) => ({
    stone_type: properties.stone_type,
    vendor_ruc: properties.vendor_ruc,
    mining_concession: properties.mining_concession,
    reinfo_id: properties.reinfo_id,
    hs_code: properties.hs_code,
  }),

  mintFields: () => ({}),

  mintFailureNote: () => null,
};
