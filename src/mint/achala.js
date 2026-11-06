/**
 * @file mint/achala.js
 * @description What minting an Achala needs beyond an Umiña mint
 * (umina-achala-chain#16). An Achala is a piece of jewelry made of one or
 * more Umiña NFTs, listed in properties.stones. The Achala's own HCS events
 * record its stones; the stones get no events of their own: the Achala's
 * MINT event lists them (from_stone_ids), which mounts them, and when the
 * piece is taken apart its Achala NFT is burned (adminToken.js burn or wipe
 * --token achala), whose BURN event unmounts them. The Umiña NFTs are never
 * burned with it, and a stone whose Achala was burned can be mounted again.
 * The buyer of an Achala gets it and each Umiña in it.
 *
 * A stone can be gold: a gold nugget is a stone, so it can be an Umiña, and
 * a gold piece is either an Umiña itself or an Achala made of a gold Umiña.
 * properties.metals says where the gold or silver of a piece comes from:
 * one of its Umiña stones (source "umina") or an invoice in documents
 * (source "invoice").
 */

import { STONE_TYPES, stoneTypeProblem } from "./stoneTypes.js";

/** Attribute names the mint script writes for an Achala. */
const ACHALA_TRAITS = ["Piece Type", "Metal", "Stones", "Artisan"];

const PIECE_NAMES = {
  ring: "Ring",
  pendant: "Pendant",
  necklace: "Necklace",
  earrings: "Earrings",
  bracelet: "Bracelet",
  brooch: "Brooch",
};

/**
 * Sets properties.umina_token_id, the Umiña token every stone of the piece
 * is in, when it is absent, so the form only needs each stone's stone_id and
 * serial. A value already there is kept, and uminaTokenProblem refuses it if
 * it is not the Umiña token.
 */
export function withUminaTokenId(metadata, uminaTokenId) {
  if (metadata.properties?.umina_token_id != null) return metadata;
  return { ...metadata, properties: { ...metadata.properties, umina_token_id: uminaTokenId } };
}

/** A problem when properties.umina_token_id is not the Umiña token, or null. */
export function uminaTokenProblem(properties, uminaTokenId) {
  if (properties.umina_token_id === String(uminaTokenId)) return null;
  return `properties.umina_token_id ${properties.umina_token_id} is not the Umiña token ${uminaTokenId} (UMINA_TOKEN_ID)`;
}

/**
 * The checks on an Achala's properties that the schema cannot express, as
 * messages: each stone listed once; each metal a metal from the stone types
 * list; a metal from an Umiña names one of the piece's stones; a metal from
 * an invoice needs a document in files.
 * @param {object} properties
 * @param {Array<{ type: string }>} files the files of the built metadata
 */
export function achalaProblems(properties = {}, files = [], types = STONE_TYPES) {
  const problems = [];
  const stones = Array.isArray(properties.stones) ? properties.stones : [];
  const seen = new Set();
  stones.forEach((s, i) => {
    for (const key of [`serial ${s?.serial}`, s?.stone_id]) {
      if (seen.has(key)) problems.push(`properties.stones[${i}] lists ${key} twice`);
      seen.add(key);
    }
  });
  const stoneIds = new Set(stones.map((s) => s?.stone_id));
  const hasDocument = files.some((f) => !String(f?.type).startsWith("image/"));
  (Array.isArray(properties.metals) ? properties.metals : []).forEach((m, i) => {
    const where = `properties.metals[${i}]`;
    if (typeof m?.stone_type === "string") {
      const p = stoneTypeProblem(m.stone_type, `${where}.stone_type`, types);
      if (p) problems.push(p);
      else if (types.get(m.stone_type).kind !== "metal") {
        problems.push(`${where}.stone_type "${m.stone_type}" is not a metal`);
      }
    }
    if (m?.source === "umina" && !stoneIds.has(m.stone_id)) {
      problems.push(`${where} comes from an Umiña, so its stone_id must be one of properties.stones`);
    }
    if (m?.source === "invoice" && !hasDocument) {
      problems.push(`${where} comes from an invoice, so add the invoice to documents`);
    }
  });
  return problems;
}

/**
 * The stones mounted in an Achala that still exists: stone_id → the
 * Achala's MINT event, from a topic's events. An Achala's MINT lists its
 * stones in from_stone_ids; a BURN of that Achala serial (taken apart)
 * frees them.
 */
export function mountedStones(events, achalaTokenId) {
  const burned = new Set(
    events
      .filter(({ event }) => event.event === "BURN" && event.token_id === String(achalaTokenId))
      .flatMap(({ event }) => event.serials ?? []),
  );
  const mounted = new Map();
  for (const entry of events) {
    const { event } = entry;
    if (
      event.event === "MINT" &&
      event.token_id === String(achalaTokenId) &&
      !(event.serials ?? []).some((serial) => burned.has(String(serial)))
    ) {
      for (const id of event.from_stone_ids ?? []) mounted.set(id, entry);
    }
  }
  return mounted;
}

/**
 * Checks each stone of an Achala against the ledger before anything is sent:
 * minted in the Umiña token under that stone_id and serial (its MINT event),
 * not burned, held by the treasury, and not mounted in another Achala. The
 * stones' token is checked first, by uminaTokenProblem.
 * @param {Array<{ serial: number, stone_id: string }>} stones
 * @param {Array<object | null>} nfts mirror node NFT info per stone (nftInfo)
 * @param {Array<{ sequence_number: number, event: object }>} events the provenance topic
 * @param {{ uminaTokenId: string, achalaTokenId: string, treasuryId: string }} ids
 * @returns {string[]}
 */
export function stoneLedgerProblems(stones, nfts, events, { uminaTokenId, achalaTokenId, treasuryId }) {
  const problems = [];
  const mounted = mountedStones(events, achalaTokenId);
  stones.forEach((stone, i) => {
    const nft = `${uminaTokenId}/${stone.serial}`;
    const mint = events.find(
      ({ event }) =>
        event.event === "MINT" &&
        event.stone_id === stone.stone_id &&
        event.token_id === String(uminaTokenId) &&
        (event.serials ?? []).includes(String(stone.serial)),
    );
    if (!mint) problems.push(`${stone.stone_id}: no MINT event for it with serial ${nft}`);
    const info = nfts[i];
    if (!info) problems.push(`${stone.stone_id}: ${nft} does not exist`);
    else if (info.deleted) problems.push(`${stone.stone_id}: ${nft} is burned`);
    else if (info.account_id !== String(treasuryId)) {
      problems.push(`${stone.stone_id}: ${nft} is held by ${info.account_id}, not the treasury ${treasuryId}`);
    }
    const earlier = mounted.get(stone.stone_id);
    if (earlier) {
      problems.push(
        `${stone.stone_id} is already mounted in Achala ${earlier.event.stone_id} (${achalaTokenId}/${earlier.event.serials.join(",")}, MINT #${earlier.sequence_number})`,
      );
    }
  });
  return problems;
}

/**
 * The stone type of each stone, from its latest COMPLIANCE event, as
 * stone_id → stone type id. Stones with none are left out.
 */
export function stoneTypesFromEvents(events, stones) {
  const ids = new Set(stones.map((s) => s.stone_id));
  const types = new Map();
  for (const { event } of events) {
    if (event.event === "COMPLIANCE" && ids.has(event.stone_id) && event.stone_type) {
      types.set(event.stone_id, event.stone_type);
    }
  }
  return types;
}

/**
 * Returns the metadata's attributes with Piece Type, Metal, Stones and
 * Artisan written from its properties, replacing any hand-written ones.
 * Stones uses each stone's type name where it is known (stoneTypeById, from
 * stoneTypesFromEvents), otherwise its stone_id.
 */
export function withAchalaAttributes(metadata, stoneTypeById = new Map(), types = STONE_TYPES) {
  const { properties = {} } = metadata;
  const typeName = (id) => types.get(id)?.name.en ?? id;
  const generated = [];
  if (PIECE_NAMES[properties.piece_type]) {
    generated.push({ trait_type: "Piece Type", value: PIECE_NAMES[properties.piece_type] });
  }
  if (Array.isArray(properties.metals) && properties.metals.length) {
    generated.push({
      trait_type: "Metal",
      value: properties.metals.map((m) => `${typeName(m.stone_type)} ${m.fineness}`).join(", "),
    });
  }
  if (Array.isArray(properties.stones)) {
    generated.push({
      trait_type: "Stones",
      value: properties.stones
        .map((s) => (stoneTypeById.has(s.stone_id) ? typeName(stoneTypeById.get(s.stone_id)) : s.stone_id))
        .join(", "),
    });
  }
  if (properties.artisan_rna) generated.push({ trait_type: "Artisan", value: properties.artisan_rna });
  const kept = (metadata.attributes ?? []).filter((a) => !ACHALA_TRAITS.includes(a.trait_type));
  return { ...metadata, attributes: [...generated, ...kept] };
}

/** The COMPLIANCE fields of an Achala, posted before its metadata is pinned. */
export function achalaComplianceFields(properties) {
  return {
    piece_type: properties.piece_type,
    artisan_rna: properties.artisan_rna,
    vendor_ruc: properties.vendor_ruc,
    hs_code: properties.hs_code,
    from_stone_ids: properties.stones.map((s) => s.stone_id),
  };
}
