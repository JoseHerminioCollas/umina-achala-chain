/**
 * @file config/testnet.js
 * @description Hedera testnet (umina-achala-chain#34). Chosen with
 * NETWORK=testnet in front of a command; NETWORK has no default.
 */

export default {
  /** The env file with this network's accounts, keys and IDs (git-ignored). */
  envFile: ".env.testnet",
  /** The mirror node REST API. */
  mirror: "https://testnet.mirrornode.hedera.com",
  enabled: true,
};
