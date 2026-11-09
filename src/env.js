/**
 * @file env.js
 * @description The environment checks shared by every script
 * (umina-achala-chain#29): one Hedera ID check and one helper that lists the
 * problems with the variables a script needs.
 */

import { parseEcdsaKey } from "./keys.js";

/** A Hedera entity ID such as an account, token or topic: 0.0.1234. */
const HEDERA_ID = /^0\.0\.\d+$/;

/** True when the value is a Hedera entity ID (0.0.1234). */
export function isHederaId(value) {
  return typeof value === "string" && HEDERA_ID.test(value);
}

/** The problem message for a value that should be a Hedera ID. */
export function idProblem(label, value) {
  return `${label} must look like 0.0.1234, got "${value}"`;
}

/**
 * Lists the problems with the environment variables a script needs, in the
 * order given, each naming the variable. What is checked follows the name:
 * - `..._ID` must be a Hedera ID (0.0.1234)
 * - `..._KEY` must be an ECDSA private key (hex or DER)
 * - anything else must be set
 * @param {Record<string, string | undefined>} env
 * @param {string[]} names
 * @returns {string[]} empty when the environment is usable
 */
export function envProblems(env, names) {
  const problems = [];
  for (const name of names) {
    const value = env[name];
    if (!value) {
      problems.push(`${name} is not set`);
    } else if (name.endsWith("_ID")) {
      if (!isHederaId(value)) problems.push(idProblem(name, value));
    } else if (name.endsWith("_KEY")) {
      try {
        parseEcdsaKey(value);
      } catch {
        problems.push(`${name} is not an ECDSA private key (hex or DER)`);
      }
    }
  }
  return problems;
}

/** The problem with a serial number given on the command line, or null. */
export function serialProblem(serial) {
  return /^[1-9]\d*$/.test(serial ?? "") ? null : "give the NFT serial number as a positive integer";
}
