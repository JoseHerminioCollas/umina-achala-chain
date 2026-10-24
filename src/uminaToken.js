/**
 * @file uminaToken.js
 * @description Environment checks and the TokenCreateTransaction for the
 * Umiña NFT class, kept apart from createUminaToken.js so they can be tested
 * without a network.
 */

import {
  CustomRoyaltyFee,
  PrivateKey,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
} from "@hashgraph/sdk";

export const TOKEN_NAME = "Umiña";
export const TOKEN_SYMBOL = "UMINA";
export const TOKEN_MEMO = "Umiña Achala: Authentic Peruvian Stones and Minerals";
export const ROYALTY = { numerator: 5, denominator: 100 };

const ACCOUNT_ID = /^0\.0\.\d+$/;
const ID_NAMES = ["OPERATOR_ID", "TREASURY_ID"];
const KEY_NAMES = [
  "OPERATOR_KEY",
  "ADMIN_KEY",
  "SUPPLY_KEY",
  "FEE_SCHEDULE_KEY",
  "PAUSE_KEY",
  "WIPE_KEY",
];

/**
 * Parses an ECDSA private key given as raw 64-character hex or as DER. DER
 * input is checked for its type, because fromStringECDSA accepts an ED25519
 * DER key without complaint and it would only fail later when signing.
 */
export function parseEcdsaKey(value) {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    return PrivateKey.fromStringECDSA(value);
  }
  const key = PrivateKey.fromStringDer(value);
  if (key.type !== "secp256k1") {
    throw new Error(`expected an ECDSA key, got ${key.type}`);
  }
  return key;
}

/**
 * Checks the environment and returns the problems found, each naming the
 * variable that is wrong. An empty array means the environment is usable.
 * METADATA_KEY defaults to ADMIN_KEY. TREASURY_KEY is required only when the
 * treasury is not the operator account, because the treasury must sign.
 */
export function validateEnv(env) {
  const problems = [];

  for (const name of ID_NAMES) {
    if (!env[name]) problems.push(`${name} is missing`);
    else if (!ACCOUNT_ID.test(env[name]))
      problems.push(`${name} must look like 0.0.1234, got "${env[name]}"`);
  }

  const keyNames = [...KEY_NAMES];
  if (env.METADATA_KEY) keyNames.push("METADATA_KEY");
  if (env.TREASURY_ID !== env.OPERATOR_ID) {
    if (!env.TREASURY_KEY)
      problems.push("TREASURY_KEY is required when TREASURY_ID is not OPERATOR_ID");
    else keyNames.push("TREASURY_KEY");
  }

  for (const name of keyNames) {
    if (!env[name]) {
      problems.push(`${name} is missing`);
      continue;
    }
    try {
      parseEcdsaKey(env[name]);
    } catch {
      problems.push(`${name} is not an ECDSA private key (hex or DER)`);
    }
  }

  return problems;
}

/** Parses the role keys from the environment (call validateEnv first). */
export function loadKeys(env) {
  const key = (name) => parseEcdsaKey(env[name]);
  return {
    admin: key("ADMIN_KEY"),
    supply: key("SUPPLY_KEY"),
    feeSchedule: key("FEE_SCHEDULE_KEY"),
    pause: key("PAUSE_KEY"),
    wipe: key("WIPE_KEY"),
    metadata: key(env.METADATA_KEY ? "METADATA_KEY" : "ADMIN_KEY"),
    treasury: env.TREASURY_KEY ? key("TREASURY_KEY") : null,
  };
}

/** Builds the (unfrozen) transaction. Only public keys are set on the token. */
export function buildTokenTransaction(env, keys) {
  const treasuryId = env.TREASURY_ID;

  return new TokenCreateTransaction()
    .setTokenName(TOKEN_NAME)
    .setTokenSymbol(TOKEN_SYMBOL)
    .setTokenType(TokenType.NonFungibleUnique)
    // Roles
    .setTreasuryAccountId(treasuryId)
    .setAutoRenewAccountId(treasuryId)
    .setAdminKey(keys.admin.publicKey)
    .setSupplyKey(keys.supply.publicKey)
    .setFeeScheduleKey(keys.feeSchedule.publicKey)
    .setPauseKey(keys.pause.publicKey)
    .setWipeKey(keys.wipe.publicKey)
    .setMetadataKey(keys.metadata.publicKey)
    // Royalty policy: 5% of resale payments, no fallback fee
    .setCustomFees([
      new CustomRoyaltyFee()
        .setNumerator(ROYALTY.numerator)
        .setDenominator(ROYALTY.denominator)
        .setFeeCollectorAccountId(treasuryId),
    ])
    // Supply and divisibility
    .setSupplyType(TokenSupplyType.Infinite)
    .setInitialSupply(0)
    .setDecimals(0)
    .setTokenMemo(TOKEN_MEMO);
}

/** Plain-text summary of the token parameters, with no keys in it. */
export function describeToken(env, keys) {
  return {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    type: "NonFungibleUnique",
    supplyType: "Infinite",
    treasury: env.TREASURY_ID,
    autoRenewAccount: env.TREASURY_ID,
    royalty: `${ROYALTY.numerator}/${ROYALTY.denominator} to ${env.TREASURY_ID}, no fallback fee`,
    memo: TOKEN_MEMO,
    roles: ["admin", "supply", "feeSchedule", "pause", "wipe", "metadata"],
    treasurySignsSeparately: Boolean(keys.treasury),
  };
}
