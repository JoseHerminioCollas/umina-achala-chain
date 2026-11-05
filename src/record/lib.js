/**
 * @file record/lib.js
 * @description Argument parsing, ledger checks and event fields for
 * recordEvent.js, kept apart from it so they can be tested without a network
 * (umina-achala-chain#8).
 *
 * recordEvent.js only records events that happened elsewhere; it never moves
 * an NFT or HBAR. Sales made by sellConsigned.js and sellOwnItem.js record
 * their own SALE, so this covers the rest: sales made wallet to wallet, paid
 * off-chain, or on a marketplace, and deliveries.
 */

import crypto from "crypto";
import { parseArgs } from "util";
import { PublicKey } from "@hashgraph/sdk";
import { normalizeTxId } from "../mirror.js";
import { submitKeyProblem } from "../hcs.js";

const ACCOUNT_ID = /^0\.0\.\d+$/;
const TOKEN_ID = /^0\.0\.\d+$/;
const HBAR_AMOUNT = /^\d+(\.\d{1,8})?$/;
const AMOUNT = /^\d+(\.\d+)?$/;
const CURRENCY = /^[A-Z]{3,5}$/;
export const COMMANDS = ["sale", "delivered"];
export const PAYMENTS = ["on_chain", "off_chain"];
/** Delivery methods supported so far (courier and export come later, #8). */
export const METHODS = ["in_person"];

const OPTIONS = {
  "dry-run": { type: "boolean" },
  "stone-id": { type: "string" },
  seller: { type: "string" },
  buyer: { type: "string" },
  payment: { type: "string" },
  "nft-tx": { type: "string" },
  "payment-tx": { type: "string" },
  "sold-for": { type: "string" },
  currency: { type: "string" },
  method: { type: "string" },
  "delivered-at": { type: "string" },
  proof: { type: "string" },
};

const SALE_ONLY = ["seller", "payment", "nft-tx", "payment-tx", "sold-for", "currency"];
const DELIVERED_ONLY = ["method", "delivered-at", "proof"];

/**
 * Parses and checks the command line. Returns the parsed input and a list of
 * problems; the input is only usable when the list is empty.
 * @param {string[]} argv the arguments after the script name
 */
export function parseRecordArgs(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    return { problems: [err.message] };
  }
  const [command, serial] = positionals;
  const problems = [];
  const input = { command, serial, dryRun: Boolean(values["dry-run"]), stoneId: values["stone-id"] };

  if (!COMMANDS.includes(command)) {
    return { ...input, problems: [`give the event: ${COMMANDS.join(" or ")}`] };
  }
  if (!/^[1-9]\d*$/.test(serial ?? "")) {
    problems.push("give the NFT serial number as a positive integer");
  }
  const notForThis = command === "sale" ? DELIVERED_ONLY : SALE_ONLY;
  notForThis
    .filter((name) => values[name] !== undefined)
    .forEach((name) => problems.push(`--${name} is not used with ${command}`));

  const account = (name) => {
    const value = values[name];
    if (!value) problems.push(`--${name} is required`);
    else if (!ACCOUNT_ID.test(value))
      problems.push(`--${name} must look like 0.0.1234, got "${value}"`);
    return value;
  };
  input.buyer = account("buyer");

  if (command === "sale") {
    input.seller = account("seller");
    if (input.seller && input.seller === input.buyer) {
      problems.push("--seller and --buyer are the same account");
    }
    input.payment = values.payment;
    if (!PAYMENTS.includes(input.payment)) {
      problems.push(`--payment must be ${PAYMENTS.join(" or ")}`);
    }
    input.nftTx = normalizeTxId(values["nft-tx"]);
    if (!values["nft-tx"]) problems.push("--nft-tx (the transaction that moved the NFT) is required");
    else if (!input.nftTx) problems.push(`--nft-tx is not a transaction ID: "${values["nft-tx"]}"`);
    if (values["payment-tx"] !== undefined) {
      input.paymentTx = normalizeTxId(values["payment-tx"]);
      if (!input.paymentTx)
        problems.push(`--payment-tx is not a transaction ID: "${values["payment-tx"]}"`);
      if (input.payment === "off_chain")
        problems.push("--payment-tx is only for on_chain payments");
    }
    input.soldFor = values["sold-for"];
    input.currency = values.currency ?? (input.payment === "on_chain" ? "HBAR" : undefined);
    if (input.payment === "on_chain" && input.currency !== "HBAR") {
      problems.push("on_chain payments are checked in HBAR only for now (--currency HBAR)");
    }
    if (input.soldFor !== undefined) {
      const pattern = input.currency === "HBAR" ? HBAR_AMOUNT : AMOUNT;
      if (!pattern.test(input.soldFor) || !(Number(input.soldFor) > 0)) {
        problems.push("--sold-for must be a positive amount (HBAR: at most 8 decimals)");
      }
      if (!input.currency) problems.push("--currency is required with --sold-for for off_chain");
      else if (!CURRENCY.test(input.currency))
        problems.push(`--currency must be a code such as HBAR, USD or PEN, got "${input.currency}"`);
    } else if (values.currency !== undefined && input.payment === "off_chain") {
      problems.push("--currency is only used with --sold-for");
    }
  } else {
    input.method = values.method ?? "in_person";
    if (!METHODS.includes(input.method)) {
      problems.push(`--method must be ${METHODS.join(" or ")} for now`);
    }
    input.deliveredAt = values["delivered-at"] ? new Date(values["delivered-at"]) : new Date();
    if (Number.isNaN(input.deliveredAt.getTime())) {
      problems.push(`--delivered-at must be a date and time, got "${values["delivered-at"]}"`);
    } else if (input.deliveredAt.getTime() > Date.now() + 60_000) {
      problems.push("--delivered-at is in the future");
    }
    input.proofFile = values.proof;
  }
  return { ...input, problems };
}

/** Lists the problems with the environment recordEvent.js needs. */
export function recordEnvProblems(env) {
  const problems = ["OPERATOR_ID", "OPERATOR_KEY", "UMINA_TOKEN_ID", "HCS_TOPIC_ID"]
    .filter((k) => !env[k])
    .map((k) => `${k} is not set`);
  if (env.UMINA_TOKEN_ID && !TOKEN_ID.test(env.UMINA_TOKEN_ID)) {
    problems.push(`UMINA_TOKEN_ID must look like 0.0.1234, got "${env.UMINA_TOKEN_ID}"`);
  }
  const submitProblem = submitKeyProblem(env);
  if (submitProblem) problems.push(submitProblem);
  return problems;
}

/** Converts a mirror node consensus timestamp ("1700000000.123456789") to a Date. */
export function consensusDate(timestamp) {
  const [seconds, nanos = "0"] = String(timestamp).split(".");
  return new Date(Number(seconds) * 1000 + Math.floor(Number(nanos.padEnd(9, "0")) / 1e6));
}

/**
 * HBAR an account paid in a transaction record, in tinybars, not counting the
 * transaction fee when that account was also the payer. Positive means paid.
 */
export function paidTinybars(record, accountId) {
  const net = (record.transfers ?? [])
    .filter((t) => t.account === accountId)
    .reduce((sum, t) => sum + BigInt(t.amount), 0n);
  const payer = String(record.transaction_id ?? "").split("-")[0];
  const fee = payer === accountId ? BigInt(record.charged_tx_fee ?? 0) : 0n;
  return -net - fee;
}

/** Tinybars in an HBAR amount given as text ("12.5" → 1250000000n). */
export function hbarToTinybars(amount) {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0") || "0");
}

/**
 * Checks a sale against the ledger: the NFT transaction moved this serial
 * from the seller to the buyer, and for on_chain payments, the buyer paid
 * (in the NFT transaction, or in the separate payment transaction) and the
 * seller received HBAR, matching --sold-for when it is given.
 * @returns {string[]} problems, empty when the ledger agrees
 */
export function saleLedgerProblems(input, tokenId, nftRecord, paymentRecord) {
  const problems = [];
  if (!nftRecord) return [`the mirror node does not know --nft-tx ${input.nftTx}`];
  if (nftRecord.result !== "SUCCESS") {
    return [`--nft-tx ${input.nftTx} did not succeed (${nftRecord.result})`];
  }
  const moved = (nftRecord.nft_transfers ?? []).some(
    (t) =>
      t.token_id === tokenId &&
      String(t.serial_number) === String(input.serial) &&
      t.sender_account_id === input.seller &&
      t.receiver_account_id === input.buyer,
  );
  if (!moved) {
    problems.push(
      `--nft-tx ${input.nftTx} did not move ${tokenId} serial ${input.serial} from ${input.seller} to ${input.buyer}`,
    );
  }
  if (input.payment !== "on_chain") return problems;

  let payRecord = nftRecord;
  if (input.paymentTx) {
    if (!paymentRecord) return [...problems, `the mirror node does not know --payment-tx ${input.paymentTx}`];
    if (paymentRecord.result !== "SUCCESS") {
      return [...problems, `--payment-tx ${input.paymentTx} did not succeed (${paymentRecord.result})`];
    }
    payRecord = paymentRecord;
  }
  const where = input.paymentTx ? `--payment-tx ${input.paymentTx}` : `--nft-tx ${input.nftTx}`;
  const paid = paidTinybars(payRecord, input.buyer);
  const received = -paidTinybars(payRecord, input.seller);
  if (paid <= 0n || received <= 0n) {
    problems.push(
      `${where} has no HBAR payment from ${input.buyer} to ${input.seller}; use --payment-tx for a separate payment, or --payment off_chain`,
    );
  } else if (input.soldFor !== undefined && paid !== hbarToTinybars(input.soldFor)) {
    problems.push(
      `${input.buyer} paid ${paid} tinybars in ${where}, but --sold-for is ${hbarToTinybars(input.soldFor)} tinybars`,
    );
  }
  return problems;
}

const matches = (event, type, tokenId, serial) =>
  event.event === type &&
  event.token_id === tokenId &&
  (event.serials ?? []).map(String).includes(String(serial));

/** The SALE already recorded for a transaction (by ref), if any. */
export function findSaleByRef(events, ref) {
  const wanted = normalizeTxId(ref);
  return events.find(({ event }) => event.event === "SALE" && normalizeTxId(event.ref) === wanted);
}

/** The latest SALE of this serial to this buyer, if any. */
export function latestSaleTo(events, tokenId, serial, buyerId) {
  return events
    .filter(({ event }) => matches(event, "SALE", tokenId, serial) && event.buyer_id === buyerId)
    .at(-1);
}

/** A DELIVERED of this serial to this buyer for this sale, if any. */
export function findDelivery(events, tokenId, serial, buyerId, saleRef) {
  const wanted = normalizeTxId(saleRef);
  return events.find(
    ({ event }) =>
      matches(event, "DELIVERED", tokenId, serial) &&
      event.buyer_id === buyerId &&
      normalizeTxId(event.ref) === wanted,
  );
}

/**
 * The message a buyer signs with the wallet that received the NFT, as proof
 * of delivery. It names the token, serial and account, so a signature for one
 * item cannot be reused for another.
 */
export function deliveryProofMessage(tokenId, serial, buyerId) {
  return `Umiña Achala delivery: account ${buyerId} received token ${tokenId} serial ${serial}.`;
}

/**
 * Hedera wallets prefix a message before signing it (hedera_signMessage):
 * "\x19Hedera Signed Message:\n" + its length + the message.
 */
export function hederaSignedMessage(message) {
  return `\x19Hedera Signed Message:\n${Buffer.byteLength(message)}${message}`;
}

/**
 * Checks a proof file ({ "message": ..., "signature": "<hex>" }) against the
 * expected message and the buyer's public key from the mirror node. Accepts a
 * signature over the message itself or over the wallet-prefixed form.
 * @param {Buffer|string} fileContent
 * @param {string} expectedMessage
 * @param {{ _type: string, key: string } | null} keyInfo
 * @returns {{ problem: string | null, proofHash?: string }}
 */
export function checkProof(fileContent, expectedMessage, keyInfo) {
  let proof;
  try {
    proof = JSON.parse(String(fileContent));
  } catch {
    return { problem: "the proof file is not JSON" };
  }
  if (typeof proof?.message !== "string" || typeof proof?.signature !== "string") {
    return { problem: 'the proof file needs "message" and "signature" (hex)' };
  }
  if (proof.message !== expectedMessage) {
    return { problem: `the proof message is not the delivery message: "${expectedMessage}"` };
  }
  if (!keyInfo) return { problem: "the mirror node does not know the buyer's account" };
  let publicKey;
  try {
    if (keyInfo._type === "ECDSA_SECP256K1") publicKey = PublicKey.fromStringECDSA(keyInfo.key);
    else if (keyInfo._type === "ED25519") publicKey = PublicKey.fromStringED25519(keyInfo.key);
    else return { problem: `the buyer's account key type ${keyInfo._type} is not supported for proofs` };
  } catch {
    return { problem: "the buyer's account key could not be read" };
  }
  const signature = Buffer.from(proof.signature.replace(/^0x/, ""), "hex");
  const signed = [proof.message, hederaSignedMessage(proof.message)].some((m) => {
    try {
      return publicKey.verify(Buffer.from(m), signature);
    } catch {
      return false;
    }
  });
  if (!signed) return { problem: "the proof signature does not match the buyer's account key" };
  return {
    problem: null,
    proofHash: crypto.createHash("sha256").update(fileContent).digest("hex"),
  };
}

/** Event-specific fields of a SALE recorded from the command line. */
export function saleFields(input) {
  return {
    seller_id: input.seller,
    buyer_id: input.buyer,
    payment: input.payment,
    ...(input.paymentTx && { payment_ref: input.paymentTx }),
    ...(input.soldFor !== undefined && { sold_for: input.soldFor, currency: input.currency }),
  };
}

/** Event-specific fields of a DELIVERED; proof is "signed" or "none". */
export function deliveredFields(input, proofHash) {
  return {
    buyer_id: input.buyer,
    method: input.method,
    delivered_at: input.deliveredAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    proof: proofHash ? "signed" : "none",
    ...(proofHash && { proof_hash: proofHash }),
  };
}
