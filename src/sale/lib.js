/**
 * @file sale/lib.js
 * @description Argument and environment checks for sellOwnItem.js, kept apart
 * from it so they can be tested without a network.
 */

import { treasuryKeyProblem } from "../keys.js";
import { submitKeyProblem } from "../hcs.js";

/** Variables sellOwnItem.js needs. TREASURY_KEY is checked separately. */
export const REQUIRED = [
  "OPERATOR_ID",
  "OPERATOR_KEY",
  "TREASURY_ID",
  "UMINA_TOKEN_ID",
  "HCS_TOPIC_ID",
  "BUYER_ID",
  "BUYER_KEY",
];

/**
 * Lists the problems with the serial, the price and the environment.
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} serial
 * @param {string | undefined} price in HBAR
 * @returns {string[]}
 */
export function saleProblems(env, serial, price) {
  const problems = REQUIRED.filter((k) => !env[k]).map((k) => `${k} is not set`);
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
