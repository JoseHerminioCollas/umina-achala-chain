/**
 * @file network.js
 * @description The Hedera network the scripts run against, chosen by the
 * NETWORK environment variable (testnet when unset), and what follows from
 * it: the env file and the mirror node (umina-achala-chain#29). Set NETWORK in
 * the shell, not in the env file, since it decides which env file is read:
 *
 *   NETWORK=testnet node src/sale/sellOwnItem.js 7 25 --dry-run
 *
 * Mainnet is listed but not enabled: its keys and accounts are not decided
 * (umina-achala-chain#6). Enabling it is `enabled: true` below.
 */

export const NETWORKS = {
  testnet: {
    envFile: ".env.testnet",
    mirror: "https://testnet.mirrornode.hedera.com",
    enabled: true,
  },
  mainnet: {
    envFile: ".env.mainnet",
    mirror: "https://mainnet.mirrornode.hedera.com",
    enabled: false,
  },
};

/** The network name from NETWORK, testnet when it is unset or empty. */
export function networkName(env = process.env) {
  return env.NETWORK || "testnet";
}

/** The problem with NETWORK, or null when the scripts can run on it. */
export function networkProblem(env = process.env) {
  const name = networkName(env);
  const network = NETWORKS[name];
  if (!network) return `NETWORK must be ${Object.keys(NETWORKS).join(" or ")}, got "${name}"`;
  if (!network.enabled) {
    return `NETWORK=${name} is not enabled yet: its keys and accounts are not decided (umina-achala-chain#6)`;
  }
  return null;
}

/** The mirror node REST base URL of the network (testnet when NETWORK is not known). */
export function mirrorNode(env = process.env) {
  return (NETWORKS[networkName(env)] ?? NETWORKS.testnet).mirror;
}

/**
 * The problem with an env file given on the command line, or null. The file
 * name must name the network, so credentials meant for one network are never
 * sent to another.
 */
export function envFileProblem(envFile, env = process.env) {
  const name = networkName(env);
  const base = envFile.split(/[\\/]/).pop();
  return base.includes(name) ? null : `${envFile} is not a ${name} env file (NETWORK is ${name})`;
}
