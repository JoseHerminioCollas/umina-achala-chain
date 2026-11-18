/**
 * @file mint/names.js
 * @description The NFT name, built by the mint (umina-achala-chain#38). A
 * post or metadata file never types its own: a number copied by hand into
 * the name (chrysocolla A was "#99" but serial 1) can never match the
 * serial. The name is the item's type and its stone_id, the number on the
 * QR label and the stone page; wallets show the serial beside it.
 *
 * - Umiña: "Opal · UMINA-2026-OP-01"
 * - Achala: "Pendant, chrysocolla in silver · ACHALA-2026-PE-01": the piece
 *   type, its stones (a stone that is the piece's metal, like a gold nugget,
 *   is named as the metal) and its metals
 */

import { STONE_TYPES } from "./stoneTypes.js";
import { PIECE_NAMES } from "./achala.js";

const SEPARATOR = " · ";

/** "a", "a and b", "a, b and c" */
function joinNames(names) {
  const list = [...new Set(names)];
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "");
}

/**
 * An Umiña's name: its stone type's English name and its stone_id.
 * @param {object} properties
 */
export function uminaName(properties = {}, types = STONE_TYPES) {
  const type = types.get(properties.stone_type)?.name.en ?? properties.stone_type;
  return [type, properties.stone_id].filter(Boolean).join(SEPARATOR);
}

/**
 * An Achala's name: piece type, stones and metals, and its stone_id. Each
 * stone is named by its type where known (stoneTypeById, from the stones'
 * COMPLIANCE events), otherwise by its stone_id, as the Stones attribute.
 * @param {object} properties
 * @param {Map<string, string>} [stoneTypeById]
 */
export function achalaName(properties = {}, stoneTypeById = new Map(), types = STONE_TYPES) {
  const lower = (id) => (types.get(id)?.name.en ?? id).toLowerCase();
  const metals = Array.isArray(properties.metals) ? properties.metals : [];
  const metalStones = new Set(metals.filter((m) => m.source === "umina").map((m) => m.stone_id));
  const stones = (Array.isArray(properties.stones) ? properties.stones : [])
    .filter((s) => !metalStones.has(s.stone_id))
    .map((s) => (stoneTypeById.has(s.stone_id) ? lower(stoneTypeById.get(s.stone_id)) : s.stone_id));
  let piece = PIECE_NAMES[properties.piece_type] ?? properties.piece_type ?? "Achala";
  if (stones.length) piece += `, ${joinNames(stones)}`;
  if (metals.length) piece += ` in ${joinNames(metals.map((m) => lower(m.stone_type)))}`;
  return [piece, properties.stone_id].filter(Boolean).join(SEPARATOR);
}

/**
 * A problem when a post or metadata file types its own name, or null.
 * @param {object} input the post or the metadata file as read
 * @param {string} file for the message
 */
export function typedNameProblem(input, file) {
  if (input?.name === null || input?.name === undefined || input?.name === "") return null;
  return `${file} has a name ("${input.name}"): the mint builds the name from the type and the stone_id; remove it (umina-achala-chain#38)`;
}

/**
 * The name the mint builds, chosen by the stone_id: an ACHALA-... id is an
 * Achala, anything else an Umiña. Without the stones' COMPLIANCE events an
 * Achala's stones are named by stone_id.
 * @param {object} metadata
 */
export function builtName(metadata) {
  const properties = metadata?.properties ?? {};
  return String(properties.stone_id ?? "").startsWith("ACHALA-") ? achalaName(properties) : uminaName(properties);
}
