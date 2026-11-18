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
 * - withName(metadata, context): the name, built by the mint (#38)
 * - complianceFields(properties): the COMPLIANCE event's own fields
 * - mintFields(metadata): extra fields of the MINT event
 * - mintFailureNote(metadata): what else to say when MINT fails after the mint
 */

import { GENERATED_TRAITS, withStoneTypeAttributes } from "./stoneTypes.js";
import { uminaName } from "./names.js";
import { CERTIFICATION_TRAITS, certificationAttributes, certificationEventFields } from "./certifications.js";

export const mintSteps = {
  fill: (metadata) => metadata,

  inputProblems: () => [],

  /** A stone depends on no other NFT, so there is nothing to check. */
  checkLedger: async () => ({ problems: [], context: {} }),

  /**
   * Stone Type, Materials and Form, from schema/stone-types.json; then
   * Certified by and Certified grade from the certifications (#38).
   */
  withAttributes: (metadata) => {
    const typed = withStoneTypeAttributes(metadata);
    const generated = typed.attributes.filter((a) => GENERATED_TRAITS.includes(a.trait_type));
    const kept = typed.attributes.filter(
      (a) => !GENERATED_TRAITS.includes(a.trait_type) && !CERTIFICATION_TRAITS.includes(a.trait_type),
    );
    return { ...typed, attributes: [...generated, ...certificationAttributes(metadata.properties), ...kept] };
  },

  /** The name, built from the stone type and the stone_id (#38). */
  withName: (metadata) => ({ ...metadata, name: uminaName(metadata.properties) }),

  /**
   * Stone type, seller's RUC, mining concession, REINFO and HS code, and the
   * issuer and report number of each certificate (#38).
   */
  complianceFields: (properties) => {
    const certifications = certificationEventFields(properties);
    return {
      stone_type: properties.stone_type,
      vendor_ruc: properties.vendor_ruc,
      mining_concession: properties.mining_concession,
      reinfo_id: properties.reinfo_id,
      hs_code: properties.hs_code,
      ...(certifications && { certifications }),
    };
  },

  mintFields: () => ({}),

  mintFailureNote: () => null,
};
