/**
 * @file config/mainnet.js
 * @description Hedera mainnet (umina-achala-chain#34). Chosen with
 * NETWORK=mainnet in front of a command; NETWORK has no default.
 *
 * Not enabled: the mainnet role keys and accounts are not decided
 * (umina-achala-chain#32). Enabling it is `enabled: true` here.
 */

export default {
  /** The env file with this network's accounts, keys and IDs (git-ignored). */
  envFile: ".env.mainnet",
  /** The mirror node REST API. */
  mirror: "https://mainnet.mirrornode.hedera.com",
  enabled: false,
};
