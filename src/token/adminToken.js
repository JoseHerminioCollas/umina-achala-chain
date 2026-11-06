/**
 * @file adminToken.js
 * @description Uses the Umiña token's admin keys on Hedera TESTNET
 * (umina-achala-chain#21). Each command is signed by its own key:
 *
 *   fees --fallback-hbar <hbar> [--royalty <percent>]   FEE_SCHEDULE_KEY
 *     Replaces the custom fees: the royalty (default 5%) to the treasury,
 *     with the fallback fee in HBAR. Use it when the HBAR price has moved
 *     the fallback fee away from about USD 3 (#6).
 *   pause / unpause                                     PAUSE_KEY
 *     Stops, or allows again, every transfer of every serial (compliance hold).
 *   wipe <serial> --account <id> --reason <text>        WIPE_KEY
 *     Removes a serial from the account that holds it; the serial is burned.
 *   burn <serial> --reason <text>                       SUPPLY_KEY
 *     Burns a serial that is still in the treasury.
 *
 * Run from the command line:
 * node src/token/adminToken.js <command> [serial] [options] [--token umina|achala] [--dry-run]
 *
 * --token chooses the token class (default umina, UMINA_TOKEN_ID). Use
 * --token achala (ACHALA_TOKEN_ID) for the jewelry class, e.g. to burn the
 * Achala NFT of a piece that is disassembled; its Umiña NFTs are kept
 * (umina-achala-chain#16).
 *
 * wipe and burn change an item, so they record a BURN event in the
 * provenance topic (#10) with the reason and how it happened (method "wipe"
 * or "burn"); the reason is public and permanent, so no personal data. They
 * check the holder first. fees and pause act on the whole token and record no
 * event. --dry-run checks the input and environment and sends nothing.
 */

import dotenv from "dotenv";
import {
  AccountId,
  Client,
  NftId,
  TokenBurnTransaction,
  TokenFeeScheduleUpdateTransaction,
  TokenId,
  TokenNftInfoQuery,
  TokenPauseTransaction,
  TokenUnpauseTransaction,
  TokenWipeTransaction,
} from "@hashgraph/sdk";
import {
  adminEnvProblems,
  ADMIN_COMMANDS,
  buildRoyaltyFee,
  parseAdminArgs,
  TOKEN_CLASSES,
} from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";

dotenv.config({ path: ".env.testnet" });

function fail(problems) {
  console.error("❌ Problems found:");
  problems.forEach((p) => console.error(`   - ${p}`));
  process.exitCode = 1;
}

/** Builds the (unfrozen) transaction for a command. */
function buildTransaction(input, env, tokenId) {
  switch (input.command) {
    case "fees":
      return new TokenFeeScheduleUpdateTransaction()
        .setTokenId(tokenId)
        .setCustomFees([buildRoyaltyFee(env.TREASURY_ID, input.fallbackHbar, input.royalty)]);
    case "pause":
      return new TokenPauseTransaction().setTokenId(tokenId);
    case "unpause":
      return new TokenUnpauseTransaction().setTokenId(tokenId);
    case "wipe":
      return new TokenWipeTransaction()
        .setTokenId(tokenId)
        .setAccountId(input.account)
        .setSerials([Number(input.serial)]);
    case "burn":
      return new TokenBurnTransaction().setTokenId(tokenId).setSerials([Number(input.serial)]);
  }
}

function describe(input, env, tokenId) {
  switch (input.command) {
    case "fees":
      return `set the fees of ${tokenId}: ${input.royalty.numerator}% royalty to ${env.TREASURY_ID}, fallback fee ${input.fallbackHbar} HBAR`;
    case "pause":
      return `pause every transfer of ${tokenId}`;
    case "unpause":
      return `allow transfers of ${tokenId} again`;
    case "wipe":
      return `wipe ${tokenId}/${input.serial} from ${input.account} and record BURN ("${input.reason}")`;
    case "burn":
      return `burn ${tokenId}/${input.serial} in the treasury and record BURN ("${input.reason}")`;
  }
}

async function main() {
  let client;
  let actionTxId;
  try {
    // --- 1. Check the command and the environment ---
    const input = parseAdminArgs(process.argv.slice(2));
    if (input.problems.length) return fail(input.problems);
    const envProblems = adminEnvProblems(process.env, input.command, input.tokenClass);
    if (envProblems.length) return fail(envProblems);

    const tokenId = TokenId.fromString(process.env[TOKEN_CLASSES[input.tokenClass].envVar]);
    const { key } = ADMIN_COMMANDS[input.command];
    console.log(`Would ${describe(input, process.env, tokenId)}, signed by ${key}.`);
    if (input.dryRun) {
      console.log("Dry run, nothing sent.");
      return;
    }

    // --- 2. Connect to Hedera testnet (UA pays the fee) ---
    const operatorId = AccountId.fromString(process.env.OPERATOR_ID);
    client = Client.forTestnet().setOperator(operatorId, parseEcdsaKey(process.env.OPERATOR_KEY));

    // --- 3. For wipe and burn, check who holds the serial ---
    if (input.command === "wipe" || input.command === "burn") {
      const holder = input.command === "wipe" ? input.account : process.env.TREASURY_ID;
      const nftId = new NftId(tokenId, Number(input.serial));
      const [info] = await new TokenNftInfoQuery().setNftId(nftId).execute(client);
      if (info.accountId.toString() !== holder) {
        const where = input.command === "burn" ? "the treasury" : "--account";
        return fail([`${nftId} is held by ${info.accountId}, not ${where} ${holder}`]);
      }
    }

    // --- 4. Sign with the command's key and execute ---
    const frozen = await buildTransaction(input, process.env, tokenId)
      .freezeWith(client)
      .sign(parseEcdsaKey(process.env[key]));
    const response = await frozen.execute(client);
    const receipt = await response.getReceipt(client);
    actionTxId = response.transactionId.toString();
    console.log(`✅ ${input.command}: ${receipt.status} (${actionTxId})`);

    // --- 5. Record BURN for wipe and burn ---
    if (ADMIN_COMMANDS[input.command].records) {
      const message = buildEvent(
        { event: "BURN", tokenId, serials: [input.serial], actorId: operatorId, ref: actionTxId },
        {
          reason: input.reason,
          method: input.command,
          ...(input.command === "wipe" && { from_id: input.account }),
        },
      );
      const hcsTxId = await submitEvent(
        client,
        process.env.HCS_TOPIC_ID,
        message,
        loadSubmitKey(process.env),
      );
      console.log(`✅ BURN recorded: ${hcsTxId}`);
    }
  } catch (err) {
    console.error("❌ Token admin failed:", err);
    if (actionTxId) {
      console.error(`   The ${process.argv[2]} already happened in ${actionTxId}, but BURN was not recorded.`);
    }
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

main();
