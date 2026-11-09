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
 *   [--sold-for <amount> [--currency <code>]] [--stone-id <id>]
 *   [--token umina|achala] [--dry-run]
 *
 * node src/record/recordEvent.js delivered <serial> --buyer <id>
 *   [--method in_person] [--delivered-at <date-time>] [--proof <file>]
 *   [--stone-id <id>] [--token umina|achala] [--dry-run]
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
 * --token achala records the event for an Achala (a piece of jewelry,
 * umina-achala-chain#26), with ACHALA_TOKEN_ID. Its sale moves the Achala and
 * every Umiña stone in it (from_stone_ids in its MINT event), so the SALE
 * checks that --nft-tx moved all of them from the seller to the buyer, and
 * adds from_stone_ids, umina_token_id and umina_serials. A DELIVERED is one
 * event on the Achala; the stones get no events of their own. Its stone_id
 * comes from the Achala's MINT unless --stone-id is given.
 *
 * Every run reads the topic and the ledger from the mirror node. --dry-run
 * does all the checks, prints the event and sends nothing.
 */

import fs from "fs";
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
import { accountKey, nftInfo, transactionRecord } from "../mirror.js";
import { readProvenance } from "../provenance.js";
import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";
import { achalaSaleFields, achalaSalePlan, mintOfSerial } from "../mint/achala.js";
import { TOKEN_CLASSES } from "../token/lib.js";
import { fail, loadEnv, runScript } from "../script.js";

loadEnv();


/** Checks a sale against the topic and the ledger; returns the event or problems. */
async function prepareSale(input, env, events) {
  const tokenId = env[TOKEN_CLASSES[input.tokenClass].envVar];
  // An Achala's sale moves its stones too: find them from its MINT (#26)
  let plan;
  if (input.tokenClass === "achala") {
    plan = achalaSalePlan(events, { uminaTokenId: env.UMINA_TOKEN_ID, achalaTokenId: tokenId, serial: input.serial });
    if (plan.problems.length) return { problems: plan.problems };
    if (input.stoneId && input.stoneId !== plan.achalaId) {
      return { problems: [`--stone-id ${input.stoneId} is not this Achala, ${plan.achalaId}`] };
    }
  }
  const alsoMoved = (plan?.stones ?? []).map((s) => ({
    tokenId: env.UMINA_TOKEN_ID,
    serial: s.serial,
    stoneId: s.stone_id,
  }));
  const earlier = findSaleByRef(events, input.nftTx);
  if (earlier) {
    return {
      problems: [`a SALE for ${input.nftTx} is already recorded (event #${earlier.sequence_number})`],
    };
  }
  const nftRecord = await transactionRecord(input.nftTx);
  const paymentRecord = input.paymentTx ? await transactionRecord(input.paymentTx) : null;
  const problems = saleLedgerProblems(input, tokenId, nftRecord, paymentRecord, alsoMoved);
  if (problems.length) return { problems };
  return {
    event: buildEvent(
      {
        event: "SALE",
        stoneId: input.stoneId ?? plan?.achalaId,
        tokenId,
        serials: [input.serial],
        actorId: env.OPERATOR_ID,
        occurredAt: consensusDate(nftRecord.consensus_timestamp),
        ref: input.nftTx,
      },
      { ...saleFields(input), ...(plan && achalaSaleFields(plan.stones, env.UMINA_TOKEN_ID)) },
    ),
  };
}

/** Checks a delivery against the topic and the ledger; returns the event or problems. */
async function prepareDelivery(input, env, events) {
  const tokenId = env[TOKEN_CLASSES[input.tokenClass].envVar];
  // An Achala's stone_id comes from its MINT, unless given
  const stoneId =
    input.stoneId ??
    (input.tokenClass === "achala" ? mintOfSerial(events, tokenId, input.serial)?.event.stone_id : undefined);
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
        stoneId,
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

const USAGE = `Record a SALE or DELIVERED event for something that already happened, after
checking it against the ledger. It never moves an NFT or HBAR.

Usage:
  node src/record/recordEvent.js sale <serial> --seller <id> --buyer <id>
    --nft-tx <tx-id> --payment <on_chain|off_chain> [--payment-tx <tx-id>]
    [--sold-for <amount> [--currency <code>]] [--stone-id <id>]
    [--token umina|achala] [--dry-run]
  node src/record/recordEvent.js delivered <serial> --buyer <id>
    [--method in_person] [--delivered-at <date-time>] [--proof <file>]
    [--stone-id <id>] [--token umina|achala] [--dry-run]`;

runScript("Recording failed", async (session) => {
  // --- 1. Check the arguments and the environment ---
  const input = parseRecordArgs(process.argv.slice(2));
  // An unknown --token is already in input.problems; check the env as for an Umiña then
  const envClass = Object.hasOwn(TOKEN_CLASSES, input.tokenClass ?? "") ? input.tokenClass : "umina";
  const problems = [...input.problems, ...recordEnvProblems(process.env, envClass)];
  if (problems.length) return fail(problems);

  // --- 2. Read the topic, then check the event against it and the ledger ---
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
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
  const client = session.connect();
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
}, { usage: USAGE });
