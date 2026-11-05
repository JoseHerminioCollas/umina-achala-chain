/**
 * @file recordEvent.js
 * @description Records a SALE or DELIVERED event in the HCS provenance topic
 * for something that already happened, after checking it against the ledger
 * through the mirror node (umina-achala-chain#8). It never moves an NFT or
 * HBAR. Sales made by sellConsigned.js and sellOwnItem.js already record their
 * own SALE; this is for the rest.
 *
 * Run from the command line:
 *
 * node src/record/recordEvent.js sale <serial> --seller <id> --buyer <id>
 *   --nft-tx <tx-id> --payment <on_chain|off_chain> [--payment-tx <tx-id>]
 *   [--sold-for <amount> [--currency <code>]] [--stone-id <id>] [--dry-run]
 *
 * node src/record/recordEvent.js delivered <serial> --buyer <id>
 *   [--method in_person] [--delivered-at <date-time>] [--proof <file>]
 *   [--stone-id <id>] [--dry-run]
 *
 * sale: --nft-tx is the transaction that moved the NFT; it must show this
 * serial going from the seller to the buyer. With on_chain, the buyer's HBAR
 * payment must be in that transaction, or in --payment-tx when it was paid
 * separately (wallet to wallet), and must equal --sold-for when that is given.
 * With off_chain (cash, bank, card), --sold-for and --currency are recorded as
 * stated. The event's ref is --nft-tx, and a SALE for the same ref is refused.
 *
 * delivered: the buyer must hold the NFT now and have a SALE on the topic;
 * the event's ref is that SALE's transaction. --proof is optional: a JSON file
 * with the delivery message (shown by --dry-run) signed by the buyer's
 * account key. With it, the signature is checked and its hash recorded
 * (proof "signed"); without it, the event is recorded with proof "none". A
 * DELIVERED already recorded for the same sale is refused.
 *
 * Every run reads the topic and the ledger from the mirror node. --dry-run
 * does all the checks, prints the event and sends nothing.
 */

import dotenv from "dotenv";
import fs from "fs";
import { Client } from "@hashgraph/sdk";
import {
  checkProof,
  consensusDate,
  deliveredFields,
  deliveryProofMessage,
  findDelivery,
  findSaleByRef,
  latestSaleTo,
  parseRecordArgs,
  recordEnvProblems,
  saleFields,
  saleLedgerProblems,
} from "./lib.js";
import { accountKey, nftInfo, topicEvents, transactionRecord } from "../mirror.js";
import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";
import { parseEcdsaKey } from "../keys.js";

dotenv.config({ path: ".env.testnet" });

function fail(problems) {
  console.error("❌ Problems found:");
  problems.forEach((p) => console.error(`   - ${p}`));
  process.exitCode = 1;
}

/** Checks a sale against the topic and the ledger; returns the event or problems. */
async function prepareSale(input, env, events) {
  const tokenId = env.UMINA_TOKEN_ID;
  const earlier = findSaleByRef(events, input.nftTx);
  if (earlier) {
    return {
      problems: [`a SALE for ${input.nftTx} is already recorded (event #${earlier.sequence_number})`],
    };
  }
  const nftRecord = await transactionRecord(input.nftTx);
  const paymentRecord = input.paymentTx ? await transactionRecord(input.paymentTx) : null;
  const problems = saleLedgerProblems(input, tokenId, nftRecord, paymentRecord);
  if (problems.length) return { problems };
  return {
    event: buildEvent(
      {
        event: "SALE",
        stoneId: input.stoneId,
        tokenId,
        serials: [input.serial],
        actorId: env.OPERATOR_ID,
        occurredAt: consensusDate(nftRecord.consensus_timestamp),
        ref: input.nftTx,
      },
      saleFields(input),
    ),
  };
}

/** Checks a delivery against the topic and the ledger; returns the event or problems. */
async function prepareDelivery(input, env, events) {
  const tokenId = env.UMINA_TOKEN_ID;
  const nft = await nftInfo(tokenId, input.serial);
  if (!nft || nft.deleted) {
    return { problems: [`${tokenId} serial ${input.serial} does not exist`] };
  }
  if (nft.account_id !== input.buyer) {
    return {
      problems: [`${tokenId} serial ${input.serial} is held by ${nft.account_id}, not the buyer ${input.buyer}`],
    };
  }
  const sale = latestSaleTo(events, tokenId, input.serial, input.buyer);
  if (!sale) {
    return {
      problems: [
        `no SALE of serial ${input.serial} to ${input.buyer} is recorded; record it first with "recordEvent.js sale"`,
      ],
    };
  }
  const saleRef = sale.event.ref;
  const earlier = findDelivery(events, tokenId, input.serial, input.buyer, saleRef);
  if (earlier) {
    return {
      problems: [`a DELIVERED for the sale ${saleRef} is already recorded (event #${earlier.sequence_number})`],
    };
  }

  const message = deliveryProofMessage(tokenId, input.serial, input.buyer);
  let proofHash;
  if (input.proofFile) {
    if (!fs.existsSync(input.proofFile)) {
      return { problems: [`proof file not found: ${input.proofFile}`] };
    }
    const result = checkProof(
      fs.readFileSync(input.proofFile),
      message,
      await accountKey(input.buyer),
    );
    if (result.problem) {
      return {
        problems: [
          `${result.problem}. Fix the proof, or leave out --proof to record the delivery with proof "none".`,
        ],
      };
    }
    proofHash = result.proofHash;
  }
  return {
    proofMessage: message,
    event: buildEvent(
      {
        event: "DELIVERED",
        stoneId: input.stoneId,
        tokenId,
        serials: [input.serial],
        actorId: env.OPERATOR_ID,
        occurredAt: input.deliveredAt,
        ref: saleRef,
      },
      deliveredFields(input, proofHash),
    ),
  };
}

async function main() {
  let client;
  try {
    // --- 1. Check the arguments and the environment ---
    const input = parseRecordArgs(process.argv.slice(2));
    const problems = [...input.problems, ...recordEnvProblems(process.env)];
    if (problems.length) return fail(problems);

    // --- 2. Read the topic, then check the event against it and the ledger ---
    let events;
    try {
      events = await topicEvents(process.env.HCS_TOPIC_ID);
    } catch (err) {
      return fail([`cannot read HCS_TOPIC_ID ${process.env.HCS_TOPIC_ID}: ${err.message}`]);
    }
    const prepared =
      input.command === "sale"
        ? await prepareSale(input, process.env, events)
        : await prepareDelivery(input, process.env, events);
    if (prepared.problems) return fail(prepared.problems);
    console.log(`✅ The ledger agrees. ${prepared.event.event} event:`);
    console.log(JSON.stringify(prepared.event, null, 2));

    if (input.dryRun) {
      if (prepared.proofMessage) {
        console.log(`Delivery message for the buyer to sign: "${prepared.proofMessage}"`);
      }
      console.log("Dry run, nothing sent.");
      return;
    }

    // --- 3. Record it (UA pays; signed with the submit key when set) ---
    client = Client.forTestnet().setOperator(
      process.env.OPERATOR_ID,
      parseEcdsaKey(process.env.OPERATOR_KEY),
    );
    const hcsTxId = await submitEvent(
      client,
      process.env.HCS_TOPIC_ID,
      prepared.event,
      loadSubmitKey(process.env),
    );
    console.table({
      event: prepared.event.event,
      nft: `${prepared.event.token_id}/${input.serial}`,
      ref: prepared.event.ref,
      hcs_tx_id: hcsTxId,
    });
  } catch (err) {
    console.error("❌ Recording failed:", err);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

main();
