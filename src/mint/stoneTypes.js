/**
 * @file mint/stoneTypes.js
 * @description The controlled list of stone types (schema/stone-types.json,
 * umina-achala-chain#14): checks a stone's properties.stone_type and
 * properties.materials against it, and builds the attributes wallets and the
 * site show (Stone Type, Materials, Form) from it, so they are never typed by
 * hand.
 */

import list from "../../schema/stone-types.json" with { type: "json" };

/** The stone types, by id. */
export const STONE_TYPES = new Map(list.types.map((t) => [t.id, t]));

/** Attribute names the mint script writes; any hand-written ones are replaced. */
export const GENERATED_TRAITS = ["Stone Type", "Materials", "Form"];

const FORM_NAMES = { natural: "Natural", worked: "Worked", crafted: "Crafted" };

/**
 * Lists the problems with one stone type id: not in the list, deprecated, or
 * a fossil (fossils are not minted, Ley 31204).
 * @param {string} id
 * @param {string} where the field, for the message
 */
export function stoneTypeProblem(id, where, types = STONE_TYPES) {
  const type = types.get(id);
  if (!type) {
    return `${where} "${id}" is not in schema/stone-types.json. Add the type to the list first (a reviewed change); there is no "other".`;
  }
  if (type.deprecated) {
    return `${where} "${id}" is deprecated${type.replaced_by ? `; use "${type.replaced_by}"` : ""}`;
  }
  if (type.kind === "fossil") {
    return `${where} "${id}" is a fossil; fossils are not minted (Ley 31204)`;
  }
  return null;
}

/**
 * Lists the problems with a stone's stone_type and materials. A materials
 * list needs exactly one host, and the host must be the stone_type.
 * @param {object} properties the metadata's properties
 * @returns {string[]}
 */
export function stoneTypeProblems(properties = {}, types = STONE_TYPES) {
  const problems = [];
  if (typeof properties.stone_type === "string") {
    const p = stoneTypeProblem(properties.stone_type, "properties.stone_type", types);
    if (p) problems.push(p);
  }
  const materials = properties.materials;
  if (Array.isArray(materials) && materials.length) {
    materials.forEach((m, i) => {
      if (typeof m?.stone_type !== "string") return;
      const p = stoneTypeProblem(m.stone_type, `properties.materials[${i}].stone_type`, types);
      if (p) problems.push(p);
    });
    const hosts = materials.filter((m) => m?.role === "host");
    if (hosts.length !== 1) {
      problems.push(`properties.materials needs exactly one host, found ${hosts.length}`);
    } else if (hosts[0].stone_type !== properties.stone_type) {
      problems.push(
        `the host in properties.materials ("${hosts[0].stone_type}") must be properties.stone_type ("${properties.stone_type}")`,
      );
    }
  }
  return problems;
}

/**
 * Returns the metadata's attributes with Stone Type, Materials and Form
 * written from the list (English names, for wallets and SentX), replacing any
 * hand-written ones. Materials is added only for a stone of several materials.
 * Call only after stoneTypeProblems found nothing.
 */
export function withStoneTypeAttributes(metadata, types = STONE_TYPES) {
  const { properties = {} } = metadata;
  const name = (id) => types.get(id).name.en;
  const generated = [{ trait_type: "Stone Type", value: name(properties.stone_type) }];
  if (Array.isArray(properties.materials) && properties.materials.length > 1) {
    generated.push({
      trait_type: "Materials",
      value: properties.materials.map((m) => name(m.stone_type)).join(", "),
    });
  }
  if (FORM_NAMES[properties.specimen_form]) {
    generated.push({ trait_type: "Form", value: FORM_NAMES[properties.specimen_form] });
  }
  const kept = (metadata.attributes ?? []).filter((a) => !GENERATED_TRAITS.includes(a.trait_type));
  return { ...metadata, attributes: [...generated, ...kept] };
}
