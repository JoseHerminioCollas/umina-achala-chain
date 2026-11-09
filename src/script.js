/**
 * @file script.js
 * @description The startup every script shares (umina-achala-chain#29): read
 * the env file of the network, print problems and set the exit code, connect
 * to Hedera as the operator, and close the client at the end.
 *
 *   loadEnv();
 *   runScript("Sale failed", async (session) => {
 *     const problems = ...;
 *     if (problems.length) return fail(problems);
 *     const client = session.connect();
 *     ...
 *   });
 */

import dotenv from "dotenv";
import { Client } from "@hashgraph/sdk";
import { parseEcdsaKey } from "./keys.js";
import { envFileProblem, NETWORKS, networkName, networkProblem } from "./network.js";

const CLIENTS = { testnet: () => Client.forTestnet(), mainnet: () => Client.forMainnet() };

/**
 * Reads the env file into process.env: the network's own file, or the one
 * given. Nothing is read when NETWORK is not usable or the file does not name
 * the network; runScript and envFileProblem then report why.
 * @param {string} [envFile]
 * @returns {string | undefined} the file read
 */
export function loadEnv(envFile) {
  if (networkProblem()) return undefined;
  const file = envFile ?? NETWORKS[networkName()].envFile;
  if (envFileProblem(file)) return undefined;
  dotenv.config({ path: file });
  return file;
}

/** Prints the problems under a heading and sets a non-zero exit code. */
export function fail(problems, heading = "Problems found") {
  console.error(`❌ ${heading}:`);
  problems.forEach((p) => console.error(`   - ${p}`));
  process.exitCode = 1;
}

/** A client for the network, with OPERATOR_ID and OPERATOR_KEY as operator (who pays). */
export function connect(env = process.env) {
  return CLIENTS[networkName(env)]().setOperator(env.OPERATOR_ID, parseEcdsaKey(env.OPERATOR_KEY));
}

/**
 * Runs a script's body. It refuses an unusable NETWORK first; an error thrown
 * by the body is printed after `failMessage` with a non-zero exit code; the
 * client opened by session.connect() is always closed. afterError runs after
 * that message, to say what already happened on the ledger.
 * @param {string} failMessage e.g. "Sale failed"
 * @param {(session: { connect: () => import("@hashgraph/sdk").Client }) => Promise<void>} body
 * @param {() => void} [afterError]
 */
export async function runScript(failMessage, body, afterError) {
  const problem = networkProblem();
  if (problem) return fail([problem]);
  let client;
  const session = {
    connect() {
      client = connect();
      return client;
    },
  };
  try {
    await body(session);
  } catch (err) {
    console.error(`❌ ${failMessage}:`, err);
    afterError?.();
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}
