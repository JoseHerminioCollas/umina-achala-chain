/**
 * @file testnet/lib.js
 * @description Argument and environment checks for transferBetweenWallets.js
 * (umina-achala-chain#40), kept apart from it so they can be tested without a
 * network.
 */

import { parseArgs } from "util";
import { envProblems } from "../env.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";

/** The test wallets the tool moves NFTs between; each has <ROLE>_ID and <ROLE>_KEY. */
export const ROLES = ["merchant", "buyer"];

/**
 * A problem unless NETWORK is testnet. Checked before the env file is read,
 * so on any other network no key is ever loaded: on mainnet UA never holds
 * the merchant's or the buyer's keys.
 * @param {Record<string, string | undefined>} env
 */
export function testnetOnlyProblem(env) {
  return env.NETWORK === "testnet"
    ? null
    : `this is a testnet-only tool: it signs with the merchant's and the buyer's keys, which UA never holds on mainnet (NETWORK is "${env.NETWORK ?? ""}")`;
}

/**
 * Turns an HBAR amount ("10", "0.00000001") into tinybars, or null when it
 * is not a positive amount with at most 8 decimals.
 * @param {string} text
 * @returns {bigint | null}
 */
export function hbarToTinybars(text) {
  if (!/^\d+(\.\d{1,8})?$/.test(text ?? "")) return null;
  const [whole, frac = ""] = text.split(".");
  const tinybars = BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, "0"));
  return tinybars > 0n ? tinybars : null;
}

/**
 * Parses <serial>[,<serial>...] --from merchant|buyer [--to merchant|buyer]
 * [--token umina|achala] [--hbar <amount>] [--dry-run]. --to defaults to the
 * other wallet. Several serials (Umiña only) move in one transfer, e.g. to
 * see how the royalty applies to two NFTs of the same token.
 * @param {string[]} argv
 */
export function parseTransferArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        token: { type: "string" },
        hbar: { type: "string" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    return { problems: [`${err.message} (see --help)`] };
  }
  const problems = [];
  const tokenClass = values.token ?? "umina";
  const tokenProblem = tokenClassProblem(tokenClass);
  if (tokenProblem) problems.push(tokenProblem);

  if (positionals.length !== 1) problems.push("give the NFT serial, or Umiña serials separated by commas (see --help)");
  const serials = (positionals[0] ?? "").split(",");
  if (positionals.length === 1) {
    if (serials.some((s) => !/^[1-9]\d*$/.test(s))) problems.push(`serials must be positive integers, got "${positionals[0]}"`);
    else if (new Set(serials).size !== serials.length) problems.push("a serial is listed twice");
    else if (tokenClass === "achala" && serials.length > 1) problems.push("give one Achala serial: it moves with its stones");
  }

  const from = values.from;
  if (!ROLES.includes(from)) problems.push(`--from must be ${ROLES.join(" or ")}`);
  const to = values.to ?? ROLES.find((r) => r !== from);
  if (values.to !== undefined && !ROLES.includes(to)) problems.push(`--to must be ${ROLES.join(" or ")}`);
  else if (from === to) problems.push("--from and --to must be different wallets");

  let tinybars = 0n;
  if (values.hbar !== undefined) {
    tinybars = hbarToTinybars(values.hbar);
    if (tinybars === null) problems.push("--hbar must be a positive amount of HBAR, at most 8 decimals (1 tinybar is 0.00000001)");
  }
  return { serials, from, to, tokenClass, tinybars, hbar: values.hbar, dryRun: Boolean(values["dry-run"]), problems };
}

/**
 * Lists the problems with the environment: both wallets' IDs and keys, the
 * token(s) and the provenance topic (read for the mounted-stone checks).
 * @param {Record<string, string | undefined>} env
 * @param {{ from: string, to: string, tokenClass: string }} input
 */
export function transferProblems(env, { from, to, tokenClass }) {
  const tokens = tokenClass === "achala" ? ["UMINA_TOKEN_ID", "ACHALA_TOKEN_ID"] : [TOKEN_CLASSES.umina.envVar];
  const wallets = [from, to].flatMap((role) => [`${role.toUpperCase()}_ID`, `${role.toUpperCase()}_KEY`]);
  return envProblems(env, [...wallets, ...tokens, "HCS_TOPIC_ID"]);
}

/**
 * The recordEvent.js command that records this transfer as a SALE, printed
 * after it settles: on_chain with the HBAR it carried, else off_chain (the
 * price is then added by hand).
 */
export function recordCommand({ serial, tokenClass, sellerId, buyerId, txId, hbar }) {
  const parts = ["NETWORK=testnet node src/record/recordEvent.js sale", serial, `--seller ${sellerId}`, `--buyer ${buyerId}`, `--nft-tx ${txId}`];
  parts.push(hbar ? `--payment on_chain --sold-for ${hbar}` : "--payment off_chain --sold-for <amount> --currency <code>");
  if (tokenClass === "achala") parts.push("--token achala");
  return parts.join(" ");
}
