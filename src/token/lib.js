/**
 * @file token/lib.js
 * @description Environment checks and the TokenCreateTransaction for the
 * Umiña and Achala NFT classes, used by createToken.js and kept apart from it so they
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
import { envProblems, idProblem, isHederaId } from "../env.js";
import { parseArgs } from "util";
import { submitKeyProblem } from "../hcs.js";

/**
 * The token classes UA creates (umina-achala-chain#15): Umiña for stones and
 * Achala for jewelry made of Umiña stones. Both share every other setting
 * (keys, no metadata key, royalty and fallback fee, infinite supply); each
 * has its own name, symbol, memo and env variable for its ID.
 */
export const TOKEN_CLASSES = {
  umina: {
    name: "Umiña",
    symbol: "UMINA",
    memo: "Umiña: Peruvian stones",
    envVar: "UMINA_TOKEN_ID",
  },
  achala: {
    name: "Achala",
    symbol: "ACHALA",
    memo: "Achala: Peruvian jewelry made of Umiña stones",
    envVar: "ACHALA_TOKEN_ID",
  },
};

/**
 * The problem with a --token value, or undefined when it names a class. Only
 * the object's own keys count, so "constructor" or "__proto__" are refused.
 */
export function tokenClassProblem(value) {
  if (Object.hasOwn(TOKEN_CLASSES, value)) return undefined;
  return `--token must be ${Object.keys(TOKEN_CLASSES).join(" or ")}, got "${value}"`;
}

/**
 * Parses and checks the command line of createToken.js:
 * [env-file] [--token umina|achala] [--dry-run], also --token=achala.
 * Returns the input and a list of problems; usable only when it is empty.
 */
export function parseCreateArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, token: { type: "string" } },
      allowPositionals: true,
    }));
  } catch (err) {
    return { problems: [err.message] };
  }
  const input = {
    envFile: positionals[0] ?? ".env.testnet",
    tokenClass: values.token ?? "umina",
    dryRun: Boolean(values["dry-run"]),
  };
  const problems = [];
  if (positionals.length > 1) problems.push(`give at most one env file, got ${positionals.join(", ")}`);
  const tokenProblem = tokenClassProblem(input.tokenClass);
  if (tokenProblem) problems.push(tokenProblem);
  return { ...input, problems };
}

export const ROYALTY = { numerator: 5, denominator: 100 };

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
  const problems = envProblems(env, ID_NAMES);

  const fallback = env.FALLBACK_FEE_HBAR;
  if (!fallback) problems.push("FALLBACK_FEE_HBAR is not set");
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
  problems.push(...envProblems(env, keyNames));

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
/**
 * The token's one custom fee: a royalty to the treasury on payments that move
 * with the NFT, with a fixed HBAR fallback fee charged to the receiver when
 * none does. Used at creation and by the fee schedule update (#21).
 * @param {string} treasuryId fee collector
 * @param {string} fallbackHbar HBAR amount, e.g. "38"
 * @param {{ numerator: number, denominator: number }} [royalty]
 */
export function buildRoyaltyFee(treasuryId, fallbackHbar, royalty = ROYALTY) {
  return new CustomRoyaltyFee()
    .setNumerator(royalty.numerator)
    .setDenominator(royalty.denominator)
    .setFeeCollectorAccountId(treasuryId)
    .setFallbackFee(new CustomFixedFee().setHbarAmount(Hbar.fromString(fallbackHbar)));
}

export function buildTokenTransaction(env, keys, tokenClass = "umina") {
  const treasuryId = env.TREASURY_ID;
  const { name, symbol, memo } = TOKEN_CLASSES[tokenClass];

  return new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
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
    .setCustomFees([buildRoyaltyFee(treasuryId, env.FALLBACK_FEE_HBAR)])
    // Supply and divisibility
    .setSupplyType(TokenSupplyType.Infinite)
    .setInitialSupply(0)
    .setDecimals(0)
    .setTokenMemo(memo);
}

/** Plain-text summary of the token parameters, with no keys in it. */
export function describeToken(env, keys, tokenClass = "umina") {
  const { name, symbol, memo, envVar } = TOKEN_CLASSES[tokenClass];
  return {
    name,
    symbol,
    saveIdAs: envVar,
    type: "NonFungibleUnique",
    supplyType: "Infinite",
    treasury: env.TREASURY_ID,
    autoRenewAccount: env.TREASURY_ID,
    royalty: `${ROYALTY.numerator}/${ROYALTY.denominator} to ${env.TREASURY_ID}`,
    fallbackFee: `${env.FALLBACK_FEE_HBAR} HBAR`,
    memo,
    roles: ["admin", "supply", "feeSchedule", "pause", "wipe"],
    metadataKey: "none (NFT metadata is immutable)",
    treasurySignsSeparately: Boolean(keys.treasury),
  };
}

// --- Token admin (adminToken.js, umina-achala-chain#21) ---

/** Each admin command: the key that signs it, and whether it records an event. */
export const ADMIN_COMMANDS = {
  fees: { key: "FEE_SCHEDULE_KEY", records: false },
  pause: { key: "PAUSE_KEY", records: false },
  unpause: { key: "PAUSE_KEY", records: false },
  wipe: { key: "WIPE_KEY", records: true },
  burn: { key: "SUPPLY_KEY", records: true },
};

const ADMIN_OPTIONS = {
  "dry-run": { type: "boolean" },
  token: { type: "string" },
  "fallback-hbar": { type: "string" },
  royalty: { type: "string" },
  account: { type: "string" },
  reason: { type: "string" },
};

const ONLY_FOR = {
  "fallback-hbar": ["fees"],
  royalty: ["fees"],
  account: ["wipe"],
  reason: ["wipe", "burn"],
};

/**
 * Parses and checks the command line of adminToken.js. Returns the input and
 * a list of problems; the input is usable only when the list is empty.
 */
export function parseAdminArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: ADMIN_OPTIONS, allowPositionals: true }));
  } catch (err) {
    return { problems: [err.message] };
  }
  const [command, serial] = positionals;
  const input = {
    command,
    serial,
    dryRun: Boolean(values["dry-run"]),
    tokenClass: values.token ?? "umina",
  };
  const tokenProblem = tokenClassProblem(input.tokenClass);
  if (tokenProblem) return { ...input, problems: [tokenProblem] };
  if (!ADMIN_COMMANDS[command]) {
    return { ...input, problems: [`give the command: ${Object.keys(ADMIN_COMMANDS).join(", ")}`] };
  }
  const problems = Object.entries(ONLY_FOR)
    .filter(([name, commands]) => values[name] !== undefined && !commands.includes(command))
    .map(([name]) => `--${name} is not used with ${command}`);

  if (command === "fees") {
    input.fallbackHbar = values["fallback-hbar"];
    if (!input.fallbackHbar) problems.push("--fallback-hbar is required (the fallback fee in HBAR)");
    else if (!HBAR_AMOUNT.test(input.fallbackHbar) || Number(input.fallbackHbar) <= 0)
      problems.push(`--fallback-hbar must be a positive HBAR amount, got "${input.fallbackHbar}"`);
    const royalty = values.royalty ?? String(ROYALTY.numerator);
    if (!/^\d+$/.test(royalty) || Number(royalty) < 1 || Number(royalty) > 100) {
      problems.push(`--royalty must be a whole percentage from 1 to 100, got "${royalty}"`);
    }
    input.royalty = { numerator: Number(royalty), denominator: 100 };
  }
  if (command === "wipe" || command === "burn") {
    if (!/^[1-9]\d*$/.test(serial ?? "")) problems.push("give the NFT serial number as a positive integer");
    input.reason = values.reason?.trim();
    if (!input.reason) problems.push("--reason is required: it is recorded in the BURN event");
    else if (input.reason.length > 200) problems.push("--reason must be at most 200 characters");
  } else if (serial !== undefined) {
    problems.push(`${command} does not take a serial number`);
  }
  if (command === "wipe") {
    input.account = values.account;
    if (!input.account) problems.push("--account is required (the account that holds the serial)");
    else if (!isHederaId(input.account)) problems.push(idProblem("--account", input.account));
  }
  return { ...input, problems };
}

/** Lists the problems with the environment for one admin command. */
export function adminEnvProblems(env, command, tokenClass = "umina") {
  const { key, records } = ADMIN_COMMANDS[command];
  const needed = ["OPERATOR_ID", "OPERATOR_KEY", TOKEN_CLASSES[tokenClass].envVar, key];
  if (command === "fees" || command === "burn") needed.push("TREASURY_ID");
  if (records) needed.push("HCS_TOPIC_ID");
  const problems = envProblems(env, needed);
  if (records) {
    const submitProblem = submitKeyProblem(env);
    if (submitProblem) problems.push(submitProblem);
  }
  return problems;
}
