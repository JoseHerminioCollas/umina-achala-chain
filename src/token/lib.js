/**
 * @file token/lib.js
 * @description Environment checks and the TokenCreateTransaction for the
 * Umiña NFT class, used by createUminaToken.js and kept apart from it so they
 * can be tested without a network.
 */

import {
  CustomFixedFee,
  CustomRoyaltyFee,
  Hbar,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
} from "@hashgraph/sdk";
import { parseEcdsaKey } from "../keys.js";

export const TOKEN_NAME = "Umiña";
export const TOKEN_SYMBOL = "UMINA";
export const TOKEN_MEMO = "Umiña Achala: Authentic Peruvian Stones and Minerals";
export const ROYALTY = { numerator: 5, denominator: 100 };

const ACCOUNT_ID = /^0\.0\.\d+$/;
// An HBAR amount with at most 8 decimals (1 tinybar = 0.00000001 HBAR)
const HBAR_AMOUNT = /^\d+(\.\d{1,8})?$/;
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
 * Checks the environment and returns the problems found, each naming the
 * variable that is wrong. An empty array means the environment is usable.
 * TREASURY_KEY is required only when the treasury is not the operator account,
 * because the treasury must sign. FALLBACK_FEE_HBAR is the royalty's fallback
 * fee in HBAR (about USD 3, converted on the day the token is created).
 */
export function validateEnv(env) {
  const problems = [];

  for (const name of ID_NAMES) {
    if (!env[name]) problems.push(`${name} is missing`);
    else if (!ACCOUNT_ID.test(env[name]))
      problems.push(`${name} must look like 0.0.1234, got "${env[name]}"`);
  }

  const fallback = env.FALLBACK_FEE_HBAR;
  if (!fallback) problems.push("FALLBACK_FEE_HBAR is missing");
  else if (!HBAR_AMOUNT.test(fallback) || Number(fallback) <= 0)
    problems.push(
      `FALLBACK_FEE_HBAR must be a positive HBAR amount such as 38 or 37.5, got "${fallback}"`,
    );

  const keyNames = [...KEY_NAMES];
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
    treasury: env.TREASURY_KEY ? key("TREASURY_KEY") : null,
  };
}

/**
 * Builds the (unfrozen) transaction. Only public keys are set on the token.
 * No metadata key is set: NFT metadata is immutable, and a key left off at
 * creation can never be added (umina-achala-chain#1).
 */
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
    // Royalty policy: 5% of resale payments. The fallback fee is charged to
    // the receiver when no HBAR or fungible token moves with the NFT.
    .setCustomFees([
      new CustomRoyaltyFee()
        .setNumerator(ROYALTY.numerator)
        .setDenominator(ROYALTY.denominator)
        .setFeeCollectorAccountId(treasuryId)
        .setFallbackFee(
          new CustomFixedFee().setHbarAmount(Hbar.fromString(env.FALLBACK_FEE_HBAR)),
        ),
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
    royalty: `${ROYALTY.numerator}/${ROYALTY.denominator} to ${env.TREASURY_ID}`,
    fallbackFee: `${env.FALLBACK_FEE_HBAR} HBAR`,
    memo: TOKEN_MEMO,
    roles: ["admin", "supply", "feeSchedule", "pause", "wipe"],
    metadataKey: "none (NFT metadata is immutable)",
    treasurySignsSeparately: Boolean(keys.treasury),
  };
}
