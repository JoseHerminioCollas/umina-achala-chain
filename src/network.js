/**
 * @file network.js
 * @description The Hedera network the scripts run against, chosen by the
 * NETWORK environment variable, and what follows from it: the env file and
 * the mirror node (umina-achala-chain#29). NETWORK has no default (#34): a
 * script refuses to run without it, so a forgotten variable never reaches
 * either network. Set it in the shell, not in the env file, since it decides
 * which env file is read:
 *
 *   NETWORK=testnet node src/sale/sellOwnItem.js 7 25 --dry-run
 *
 * The networks' settings are in config/testnet.js and config/mainnet.js.
 * Mainnet is listed but not enabled until its keys and accounts are decided
 * (umina-achala-chain#32).
 */

import testnet from "../config/testnet.js";
import mainnet from "../config/mainnet.js";

export const NETWORKS = { testnet, mainnet };

/** The network name from NETWORK, or undefined when it is unset or empty. */
export function networkName(env = process.env) {
  return env.NETWORK || undefined;
}

/** The problem with NETWORK, or null when the scripts can run on it. */
export function networkProblem(env = process.env) {
  const name = networkName(env);
  const names = Object.keys(NETWORKS).join(" or ");
  if (!name) {
    return `NETWORK is not set: put NETWORK=testnet or NETWORK=mainnet in front of the command`;
  }
  if (!Object.hasOwn(NETWORKS, name)) return `NETWORK must be ${names}, got "${name}"`;
  if (!NETWORKS[name].enabled) {
    return `NETWORK=${name} is not enabled yet: its keys and accounts are not decided (umina-achala-chain#32)`;
  }
  return null;
}

/**
 * The mirror node REST base URL of the network. Throws when NETWORK does not
 * name a network, rather than read another network's data.
 */
export function mirrorNode(env = process.env) {
  const name = networkName(env);
  if (!name || !Object.hasOwn(NETWORKS, name)) throw new Error(networkProblem(env));
  return NETWORKS[name].mirror;
}

/**
 * The problem with an env file given on the command line, or null. The file
 * name must name the network, so credentials meant for one network are never
 * sent to another. With NETWORK unset or unknown it is null: runScript
 * reports that first, and loadEnv reads nothing.
 */
export function envFileProblem(envFile, env = process.env) {
  const name = networkName(env);
  if (!name || !Object.hasOwn(NETWORKS, name)) return null;
  const base = envFile.split(/[\\/]/).pop();
  return base.includes(name) ? null : `${envFile} is not a ${name} env file (NETWORK is ${name})`;
}
