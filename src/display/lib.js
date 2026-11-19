/**
 * @file display/lib.js
 * @description Argument parsing, checks and event fields for displayEvent.js,
 * kept apart from it so they can be tested without a network
 * (umina-achala-chain#43).
 *
 * The display topic says what UA has for sale on its site and at what price
 * (umina-achala-chain#10): LISTED (with a price in HBAR) and UNLISTED. An item
 * is listed when its latest LISTED / UNLISTED, made since the NFT last arrived
 * in the Treasury, is a LISTED. A listing made before the NFT was sold does
 * not list it again when it comes back: it is listed again by hand.
 */

import { parseArgs } from "util";
import { envProblems } from "../env.js";
import { submitKeyProblem } from "../hcs.js";
import { hbarToTinybars } from "../record/lib.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";

export const COMMANDS = ["listed", "unlisted", "status"];

/** The display events this script records. */
export const DISPLAY_EVENTS = { listed: "LISTED", unlisted: "UNLISTED" };

/** Only HBAR for now; other currencies are Phase 2C (umina-achala-web#128). */
export const CURRENCY = "HBAR";

/** An UNLISTED reason is public and permanent; keep it short. */
export const MAX_REASON_LENGTH = 200;

const HBAR_AMOUNT = /^\d+(\.\d{1,8})?$/;

const OPTIONS = {
  "dry-run": { type: "boolean" },
  token: { type: "string" },
  price: { type: "string" },
  reason: { type: "string" },
};

/**
 * Parses and checks the command line:
 *   listed <serial> --price <hbar> [--token umina|achala] [--dry-run]
 *   unlisted <serial> [--reason <text>] [--token umina|achala] [--dry-run]
 *   status [--token umina|achala]
 * Returns the input and a list of problems; usable only when it is empty.
 * For status, tokenClass is undefined when --token is not given (both).
 * @param {string[]} argv the arguments after the script name
 */
export function parseDisplayArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (err) {
    return { problems: [`${err.message} (see --help)`] };
  }
  const [command, serial, ...extra] = positionals;
  const input = {
    command,
    serial,
    tokenClass: values.token ?? (command === "status" ? undefined : "umina"),
    price: values.price,
    reason: values.reason,
    dryRun: Boolean(values["dry-run"]),
  };
  if (!COMMANDS.includes(command)) {
    return { ...input, problems: [`give the command: ${COMMANDS.join(", ")} (see --help)`] };
  }
  const problems = [];
  if (extra.length) problems.push(`too many arguments: ${extra.join(" ")}`);
  if (values.token !== undefined) {
    const tokenProblem = tokenClassProblem(values.token);
    if (tokenProblem) problems.push(tokenProblem);
  }

  if (command === "status") {
    if (serial !== undefined) problems.push("status takes no serial: it shows every item the Treasury holds");
    for (const name of ["price", "reason", "dry-run"]) {
      if (values[name] !== undefined) problems.push(`--${name} is not used with status`);
    }
    return { ...input, problems };
  }

  if (!/^[1-9]\d*$/.test(serial ?? "")) problems.push("give the NFT serial number as a positive integer");
  if (command === "listed") {
    if (input.price === undefined) problems.push("--price is required: the asking price in HBAR");
    else if (!HBAR_AMOUNT.test(input.price) || !(Number(input.price) > 0)) {
      problems.push(`--price must be a positive amount in HBAR, at most 8 decimals, got "${input.price}"`);
    }
    if (input.reason !== undefined) problems.push("--reason is only used with unlisted");
  } else {
    if (input.price !== undefined) problems.push("--price is only used with listed");
    if (input.reason !== undefined) {
      if (!input.reason.trim()) problems.push("--reason is empty");
      else if (input.reason.length > MAX_REASON_LENGTH) {
        problems.push(`--reason is ${input.reason.length} characters, at most ${MAX_REASON_LENGTH}`);
      }
    }
  }
  return { ...input, problems };
}

/**
 * Lists the problems with the environment. Both token IDs are needed: an
 * Umiña is checked against the Achala pieces it may be mounted in, and an
 * Achala names its stones in the Umiña token. Recording also needs the
 * operator (who pays) and, when set, a valid HCS_SUBMIT_KEY.
 * @param {Record<string, string | undefined>} env
 * @param {string} command
 */
export function displayEnvProblems(env, command) {
  const names = ["TREASURY_ID", "UMINA_TOKEN_ID", "ACHALA_TOKEN_ID", "HCS_TOPIC_ID", "HCS_DISPLAY_TOPIC_ID"];
  if (command !== "status") names.unshift("OPERATOR_ID", "OPERATOR_KEY");
  const problems = envProblems(env, names);
  if (command !== "status") {
    const submitProblem = submitKeyProblem(env);
    if (submitProblem) problems.push(submitProblem);
  }
  return problems;
}

/** The token classes a command covers: the one given, or both for status. */
export function tokenClasses(input) {
  return input.tokenClass ? [input.tokenClass] : Object.keys(TOKEN_CLASSES);
}

/**
 * A consensus timestamp ("1700000000.123456789") as one BigInt of
 * nanoseconds, so two can be compared exactly.
 */
export function timestampNanos(timestamp) {
  const [seconds, nanos = "0"] = String(timestamp).split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0").slice(0, 9));
}

/** An HBAR amount written the short way: "50.50" → "50.5", "007" → "7". */
export function canonicalHbar(amount) {
  const tinybars = hbarToTinybars(amount);
  const whole = tinybars / 100_000_000n;
  const fraction = (tinybars % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * The item's listing now: the latest LISTED or UNLISTED for this token and
 * serial made after `since` (when the NFT last arrived in the Treasury). An
 * event without a consensus timestamp, or made at or before `since`, does not
 * count.
 * @param {Array<{ sequence_number: number, consensus_timestamp?: string, event: object }>} displayEvents
 * @param {string} tokenId
 * @param {string|number} serial
 * @param {string | null} since consensus timestamp, or null to count every event
 * @returns {{ listed: boolean, price?: string, sequence_number?: number }}
 */
export function currentListing(displayEvents, tokenId, serial, since) {
  const after = since ? timestampNanos(since) : null;
  const latest = displayEvents
    .filter(
      ({ event, consensus_timestamp }) =>
        Object.values(DISPLAY_EVENTS).includes(event.event) &&
        event.token_id === String(tokenId) &&
        (event.serials ?? []).map(String).includes(String(serial)) &&
        (after === null || (consensus_timestamp && timestampNanos(consensus_timestamp) > after)),
    )
    .at(-1);
  if (!latest || latest.event.event !== "LISTED") return { listed: false };
  return { listed: true, price: latest.event.price, sequence_number: latest.sequence_number };
}

/**
 * The problem with recording this command given the item's listing now, or
 * null: listing again at the same price changes nothing, and only a listed
 * item can be unlisted.
 * @param {{ command: string, price?: string }} input
 * @param {{ listed: boolean, price?: string, sequence_number?: number }} listing
 */
export function listingProblem(input, listing) {
  if (input.command === "listed" && listing.listed && listing.price === canonicalHbar(input.price)) {
    return `already listed at ${listing.price} ${CURRENCY} (display event #${listing.sequence_number}); give another --price to change it`;
  }
  if (input.command === "unlisted" && !listing.listed) {
    return "it is not listed now, so there is nothing to unlist";
  }
  return null;
}

/** The event-specific fields of LISTED (price, currency) or UNLISTED (reason). */
export function displayFields(input) {
  if (input.command === "listed") return { price: canonicalHbar(input.price), currency: CURRENCY };
  return input.reason ? { reason: input.reason.trim() } : {};
}
