/**
 * @file script.js
 * @description The startup every script shares (umina-achala-chain#29): read
 * the env file of the network, print problems and set the exit code, connect
 * to Hedera as the operator, and close the client at the end.
 *
 *   const args = parseScriptArgs({ "dry-run": { type: "boolean" } }, 2);
 *   loadEnv();
 *   runScript("Sale failed", async (session) => {
 *     if (args.problems.length) return fail(args.problems);
 *     const problems = ...;
 *     if (problems.length) return fail(problems);
 *     const client = session.connect();
 *     ...
 *   }, { usage: USAGE });
 *
 * Every script takes --help (or -h): it prints the usage and exits without
 * reading the env file or touching the network.
 */

import dotenv from "dotenv";
import { parseArgs } from "util";
import { Client } from "@hashgraph/sdk";
import { parseEcdsaKey } from "./keys.js";
import { envFileProblem, NETWORKS, networkName, networkProblem } from "./network.js";

const CLIENTS = { testnet: () => Client.forTestnet(), mainnet: () => Client.forMainnet() };

/** Printed under every script's usage by --help. */
const COMMON_HELP = `
Common:
  --dry-run       check everything and send nothing (where the script takes it)
  -h, --help      show this help
  NETWORK=<name>  the network, required, set in the shell: testnet or mainnet
                  (not enabled yet). The env file is the network's own,
                  .env.testnet for testnet.`;

/** True when the command line asks for help (--help or -h). */
export function helpRequested(argv = process.argv.slice(2)) {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * Parses a script's command line strictly: an option the script does not
 * take, a missing option value or too many arguments is a problem, so a
 * mistyped --dry-run never sends a real transaction.
 * @param {import("util").ParseArgsConfig["options"]} options
 * @param {number} [maxPositionals] how many plain arguments the script takes
 * @param {string[]} [argv]
 * @returns {{ values: Record<string, any>, positionals: string[], problems: string[] }}
 */
export function parseScriptArgs(options, maxPositionals = Infinity, argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
    const problems =
      positionals.length > maxPositionals
        ? [`too many arguments: ${positionals.slice(maxPositionals).join(" ")} (see --help)`]
        : [];
    return { values, positionals, problems };
  } catch (err) {
    return { values: {}, positionals: [], problems: [`${err.message} (see --help)`] };
  }
}

/**
 * Reads the env file into process.env: the network's own file, or the one
 * given. Nothing is read when NETWORK is not usable or the file does not name
 * the network; runScript and envFileProblem then report why.
 * @param {string} [envFile]
 * @returns {string | undefined} the file read
 */
export function loadEnv(envFile) {
  if (helpRequested() || networkProblem()) return undefined;
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
 * Runs a script's body. With --help it prints the usage and stops. It
 * refuses an unusable NETWORK first; an error thrown by the body is printed
 * after `failMessage` with a non-zero exit code; the client opened by
 * session.connect() is always closed. afterError runs after that message, to
 * say what already happened on the ledger.
 * @param {string} failMessage e.g. "Sale failed"
 * @param {(session: { connect: () => import("@hashgraph/sdk").Client }) => Promise<void>} body
 * @param {{ usage?: string, afterError?: () => void }} [options]
 */
export async function runScript(failMessage, body, { usage, afterError } = {}) {
  if (helpRequested()) {
    console.log(`${usage ?? "No usage text for this script."}\n${COMMON_HELP}`);
    return;
  }
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
