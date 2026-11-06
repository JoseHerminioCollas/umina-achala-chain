/**
 * @file sale/lib.js
 * @description Argument and environment checks for sellOwnItem.js, kept apart
 * from it so they can be tested without a network.
 */

import { parseArgs } from "util";
import { treasuryKeyProblem } from "../keys.js";
import { submitKeyProblem } from "../hcs.js";
import { TOKEN_CLASSES, tokenClassProblem } from "../token/lib.js";

/**
 * Variables sellOwnItem.js needs, besides the token class's own ID
 * (UMINA_TOKEN_ID or ACHALA_TOKEN_ID). TREASURY_KEY is checked separately.
 */
export const REQUIRED = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "TREASURY_ID",
  "HCS_TOPIC_ID",
  "BUYER_ID",
  "BUYER_KEY",
];

/**
 * Parses the command line of sellOwnItem.js:
 * <serial> <price-hbar> [--token umina|achala] [--dry-run].
 * Returns { serial, price, tokenClass, dryRun, problems }.
 */
export function parseSaleArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, token: { type: "string" } },
      allowPositionals: true,
    }));
  } catch (err) {
    return { problems: [err.message] };
  }
  const [serial, price] = positionals;
  const input = { serial, price, tokenClass: values.token ?? "umina", dryRun: Boolean(values["dry-run"]) };
  const problems = [];
  if (positionals.length > 2) problems.push(`give a serial and a price, got ${positionals.join(" ")}`);
  const tokenProblem = tokenClassProblem(input.tokenClass);
  if (tokenProblem) problems.push(tokenProblem);
  return { ...input, problems };
}

/**
 * Lists the problems with the serial, the price and the environment. An
 * Achala sale also needs UMINA_TOKEN_ID, to move its stones.
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} serial
 * @param {string | undefined} price in HBAR
 * @param {"umina" | "achala"} [tokenClass]
 * @returns {string[]}
 */
export function saleProblems(env, serial, price, tokenClass = "umina") {
  const needed = [...REQUIRED];
  needed.splice(3, 0, TOKEN_CLASSES[tokenClass].envVar);
  if (tokenClass === "achala") needed.splice(3, 0, "UMINA_TOKEN_ID");
  const problems = needed.filter((k) => !env[k]).map((k) => `${k} is not set`);
  if (!/^[1-9]\d*$/.test(serial ?? "")) {
    problems.push("give the NFT serial number as a positive integer");
  }
  if (!/^\d+(\.\d{1,8})?$/.test(price ?? "") || !(Number(price) > 0)) {
    problems.push("give the price in HBAR as a positive number, at most 8 decimals");
  }
  for (const problem of [treasuryKeyProblem(env), submitKeyProblem(env)]) {
    if (problem) problems.push(problem);
  }
  return problems;
}
