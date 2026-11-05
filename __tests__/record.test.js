import { PrivateKey } from "@hashgraph/sdk";
import {
  checkProof,
  consensusDate,
  deliveredFields,
  deliveryProofMessage,
  findDelivery,
  findSaleByRef,
  hbarToTinybars,
  hederaSignedMessage,
  latestSaleTo,
  paidTinybars,
  parseRecordArgs,
  recordEnvProblems,
  saleFields,
  saleLedgerProblems,
} from "../src/record/lib.js";

const TOKEN = "0.0.2002";
const SELLER = "0.0.4004";
const BUYER = "0.0.6006";
const NFT_TX = "0.0.6006@1700000000.000000001";

const saleArgs = (...extra) => [
  "sale", "7", "--seller", SELLER, "--buyer", BUYER, "--nft-tx", NFT_TX, ...extra,
];

describe("parseRecordArgs", () => {
  test("parses an on_chain sale, with HBAR as the default currency", () => {
    const input = parseRecordArgs(saleArgs("--payment", "on_chain", "--sold-for", "100"));
    expect(input.problems).toEqual([]);
    expect(input).toMatchObject({
      command: "sale", serial: "7", seller: SELLER, buyer: BUYER,
      payment: "on_chain", nftTx: NFT_TX, soldFor: "100", currency: "HBAR", dryRun: false,
    });
  });

  test("normalizes the mirror node form of a transaction ID", () => {
    const input = parseRecordArgs([
      "sale", "7", "--seller", SELLER, "--buyer", BUYER, "--payment", "on_chain",
      "--nft-tx", "0.0.6006-1700000000-1", "--payment-tx", "0.0.6006-1700000001-000000002",
    ]);
    expect(input.nftTx).toBe(NFT_TX);
    expect(input.paymentTx).toBe("0.0.6006@1700000001.000000002");
  });

  test("parses an off_chain sale with a stated price in another currency", () => {
    const input = parseRecordArgs(
      saleArgs("--payment", "off_chain", "--sold-for", "350.50", "--currency", "PEN", "--dry-run"),
    );
    expect(input.problems).toEqual([]);
    expect(input).toMatchObject({ payment: "off_chain", soldFor: "350.50", currency: "PEN", dryRun: true });
  });

  test("an off_chain sale may leave the price out", () => {
    const input = parseRecordArgs(saleArgs("--payment", "off_chain"));
    expect(input.problems).toEqual([]);
    expect(input.soldFor).toBeUndefined();
    expect(input.currency).toBeUndefined();
  });

  test("lists what is missing or wrong in a sale", () => {
    expect(parseRecordArgs(["sale", "0", "--buyer", "6006"]).problems).toEqual([
      "give the NFT serial number as a positive integer",
      '--buyer must look like 0.0.1234, got "6006"',
      "--seller is required",
      "--payment must be on_chain or off_chain",
      "--nft-tx (the transaction that moved the NFT) is required",
    ]);
  });

  test("refuses the same seller and buyer, and a payment-tx on an off_chain sale", () => {
    const input = parseRecordArgs([
      "sale", "7", "--seller", BUYER, "--buyer", BUYER, "--nft-tx", NFT_TX,
      "--payment", "off_chain", "--payment-tx", NFT_TX,
    ]);
    expect(input.problems).toEqual([
      "--seller and --buyer are the same account",
      "--payment-tx is only for on_chain payments",
    ]);
  });

  test("checks HBAR amounts and currencies", () => {
    expect(parseRecordArgs(saleArgs("--payment", "on_chain", "--sold-for", "1.123456789")).problems)
      .toEqual(["--sold-for must be a positive amount (HBAR: at most 8 decimals)"]);
    expect(parseRecordArgs(saleArgs("--payment", "on_chain", "--currency", "USDC")).problems)
      .toEqual(["on_chain payments are checked in HBAR only for now (--currency HBAR)"]);
    expect(parseRecordArgs(saleArgs("--payment", "off_chain", "--sold-for", "10")).problems)
      .toEqual(["--currency is required with --sold-for for off_chain"]);
    expect(parseRecordArgs(saleArgs("--payment", "off_chain", "--sold-for", "10", "--currency", "soles")).problems)
      .toEqual(['--currency must be a code such as HBAR, USD or PEN, got "soles"']);
    expect(parseRecordArgs(saleArgs("--payment", "off_chain", "--currency", "PEN")).problems)
      .toEqual(["--currency is only used with --sold-for"]);
  });

  test("parses a delivery, in person by default, delivered now by default", () => {
    const before = Date.now();
    const input = parseRecordArgs(["delivered", "7", "--buyer", BUYER]);
    expect(input.problems).toEqual([]);
    expect(input.method).toBe("in_person");
    expect(input.deliveredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(input.proofFile).toBeUndefined();
  });

  test("checks the delivery method and time", () => {
    expect(parseRecordArgs(["delivered", "7", "--buyer", BUYER, "--method", "courier"]).problems)
      .toEqual(["--method must be in_person for now"]);
    expect(parseRecordArgs(["delivered", "7", "--buyer", BUYER, "--delivered-at", "yesterday"]).problems)
      .toEqual(['--delivered-at must be a date and time, got "yesterday"']);
    expect(parseRecordArgs(["delivered", "7", "--buyer", BUYER, "--delivered-at", "2999-01-01T00:00:00Z"]).problems)
      .toEqual(["--delivered-at is in the future"]);
  });

  test("refuses options that belong to the other event", () => {
    expect(parseRecordArgs(["delivered", "7", "--buyer", BUYER, "--sold-for", "5"]).problems)
      .toEqual(["--sold-for is not used with delivered"]);
    expect(parseRecordArgs([...saleArgs("--payment", "on_chain"), "--proof", "p.json"]).problems)
      .toEqual(["--proof is not used with sale"]);
  });

  test("needs the event name and rejects unknown options", () => {
    expect(parseRecordArgs(["7"]).problems).toEqual(["give the event: sale or delivered"]);
    expect(parseRecordArgs(["sale", "7", "--price", "5"]).problems[0]).toMatch(/--price/);
  });
});

describe("recordEnvProblems", () => {
  const env = { OPERATOR_ID: "0.0.1001", OPERATOR_KEY: "k", UMINA_TOKEN_ID: TOKEN, HCS_TOPIC_ID: "0.0.3003" };

  test("accepts a complete environment", () => {
    expect(recordEnvProblems(env)).toEqual([]);
  });

  test("names what is missing and a bad submit key", () => {
    expect(recordEnvProblems({ OPERATOR_ID: "0.0.1001", HCS_SUBMIT_KEY: "x" })).toEqual([
      "OPERATOR_KEY is not set",
      "UMINA_TOKEN_ID is not set",
      "HCS_TOPIC_ID is not set",
      "HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    ]);
  });
});

describe("amounts and times", () => {
  test("hbarToTinybars", () => {
    expect(hbarToTinybars("100")).toBe(10_000_000_000n);
    expect(hbarToTinybars("12.5")).toBe(1_250_000_000n);
    expect(hbarToTinybars("0.00000001")).toBe(1n);
  });

  test("consensusDate", () => {
    expect(consensusDate("1700000000.123456789").toISOString()).toBe("2023-11-14T22:13:20.123Z");
  });

  test("paidTinybars leaves out the fee when the account was the payer", () => {
    const record = {
      transaction_id: `${BUYER}-1700000000-000000001`,
      charged_tx_fee: 100_000,
      transfers: [
        { account: BUYER, amount: -10_000_100_000 },
        { account: SELLER, amount: 10_000_000_000 },
        { account: "0.0.3", amount: 100_000 },
      ],
    };
    expect(paidTinybars(record, BUYER)).toBe(10_000_000_000n);
    expect(paidTinybars(record, SELLER)).toBe(-10_000_000_000n);
  });
});

describe("saleLedgerProblems", () => {
  const nftMove = { token_id: TOKEN, serial_number: 7, sender_account_id: SELLER, receiver_account_id: BUYER };
  const atomic = {
    result: "SUCCESS",
    transaction_id: `${BUYER}-1700000000-000000001`,
    charged_tx_fee: 0,
    nft_transfers: [nftMove],
    transfers: [
      { account: BUYER, amount: -10_000_000_000 },
      { account: SELLER, amount: 9_500_000_000 },
      { account: "0.0.1001", amount: 500_000_000 }, // royalty
    ],
  };
  const sale = (extra = {}) => ({ serial: "7", seller: SELLER, buyer: BUYER, nftTx: NFT_TX, payment: "on_chain", ...extra });

  test("accepts an atomic sale whose price matches --sold-for", () => {
    expect(saleLedgerProblems(sale({ soldFor: "100" }), TOKEN, atomic)).toEqual([]);
  });

  test("names a price that does not match", () => {
    expect(saleLedgerProblems(sale({ soldFor: "90" }), TOKEN, atomic)).toEqual([
      `${BUYER} paid 10000000000 tinybars in --nft-tx ${NFT_TX}, but --sold-for is 9000000000 tinybars`,
    ]);
  });

  test("names an NFT transaction that moved something else", () => {
    const other = { ...atomic, nft_transfers: [{ ...nftMove, serial_number: 8 }] };
    expect(saleLedgerProblems(sale(), TOKEN, other)[0]).toBe(
      `--nft-tx ${NFT_TX} did not move ${TOKEN} serial 7 from ${SELLER} to ${BUYER}`,
    );
  });

  test("refuses an unknown or failed transaction", () => {
    expect(saleLedgerProblems(sale(), TOKEN, null)).toEqual([
      `the mirror node does not know --nft-tx ${NFT_TX}`,
    ]);
    expect(saleLedgerProblems(sale(), TOKEN, { ...atomic, result: "INVALID_SIGNATURE" })).toEqual([
      `--nft-tx ${NFT_TX} did not succeed (INVALID_SIGNATURE)`,
    ]);
  });

  test("a wallet-to-wallet sale: NFT in one transaction, payment in another", () => {
    const nftOnly = { ...atomic, transfers: [] };
    const payment = {
      result: "SUCCESS",
      transaction_id: `${BUYER}-1700000001-000000002`,
      charged_tx_fee: 0,
      transfers: [
        { account: BUYER, amount: -5_000_000_000 },
        { account: SELLER, amount: 5_000_000_000 },
      ],
    };
    const input = sale({ paymentTx: "0.0.6006@1700000001.000000002", soldFor: "50" });
    expect(saleLedgerProblems(input, TOKEN, nftOnly, payment)).toEqual([]);
    expect(saleLedgerProblems(sale(), TOKEN, nftOnly)).toEqual([
      `--nft-tx ${NFT_TX} has no HBAR payment from ${BUYER} to ${SELLER}; use --payment-tx for a separate payment, or --payment off_chain`,
    ]);
  });

  test("an off_chain sale needs only the NFT move", () => {
    expect(saleLedgerProblems(sale({ payment: "off_chain" }), TOKEN, { ...atomic, transfers: [] })).toEqual([]);
  });
});

describe("finding events on the topic", () => {
  const events = [
    { sequence_number: 1, event: { event: "SALE", token_id: TOKEN, serials: ["7"], buyer_id: "0.0.5005", ref: "0.0.1@1.1" } },
    { sequence_number: 2, event: { event: "SALE", token_id: TOKEN, serials: ["7"], buyer_id: BUYER, ref: "0.0.1001@1700000000.5" } },
    { sequence_number: 3, event: { event: "DELIVERED", token_id: TOKEN, serials: ["7"], buyer_id: BUYER, ref: "0.0.1001@1700000000.000000005" } },
  ];

  test("findSaleByRef matches either form of the transaction ID", () => {
    expect(findSaleByRef(events, "0.0.1001-1700000000-000000005").sequence_number).toBe(2);
    expect(findSaleByRef(events, NFT_TX)).toBeUndefined();
  });

  test("latestSaleTo finds the buyer's sale of that serial", () => {
    expect(latestSaleTo(events, TOKEN, "7", BUYER).sequence_number).toBe(2);
    expect(latestSaleTo(events, TOKEN, "8", BUYER)).toBeUndefined();
  });

  test("findDelivery matches the sale it refers to", () => {
    expect(findDelivery(events, TOKEN, "7", BUYER, "0.0.1001@1700000000.5").sequence_number).toBe(3);
    expect(findDelivery(events, TOKEN, "7", BUYER, "0.0.1@1.1")).toBeUndefined();
  });
});

describe("checkProof", () => {
  const message = deliveryProofMessage(TOKEN, "7", BUYER);
  const ecdsa = PrivateKey.generateECDSA();
  const ed25519 = PrivateKey.generateED25519();
  const ecdsaInfo = { _type: "ECDSA_SECP256K1", key: ecdsa.publicKey.toStringRaw() };
  const file = (key, text = message, signed = text) =>
    JSON.stringify({ message: text, signature: Buffer.from(key.sign(Buffer.from(signed))).toString("hex") });

  test("the delivery message names the account, token and serial", () => {
    expect(message).toBe(`Umiña Achala delivery: account ${BUYER} received token ${TOKEN} serial 7.`);
  });

  test("accepts a signature over the message and returns the file's hash", () => {
    const content = file(ecdsa);
    const result = checkProof(content, message, ecdsaInfo);
    expect(result.problem).toBeNull();
    expect(result.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("accepts a wallet signature over the prefixed message", () => {
    const content = file(ecdsa, message, hederaSignedMessage(message));
    expect(checkProof(content, message, ecdsaInfo).problem).toBeNull();
  });

  test("accepts an ED25519 account key", () => {
    const info = { _type: "ED25519", key: ed25519.publicKey.toStringRaw() };
    expect(checkProof(file(ed25519), message, info).problem).toBeNull();
  });

  test("refuses a signature by another key", () => {
    expect(checkProof(file(PrivateKey.generateECDSA()), message, ecdsaInfo).problem).toBe(
      "the proof signature does not match the buyer's account key",
    );
  });

  test("refuses a different message", () => {
    const other = deliveryProofMessage(TOKEN, "8", BUYER);
    expect(checkProof(file(ecdsa, other), message, ecdsaInfo).problem).toMatch(
      /^the proof message is not the delivery message/,
    );
  });

  test("refuses a malformed file and an unknown account", () => {
    expect(checkProof("not json", message, ecdsaInfo).problem).toBe("the proof file is not JSON");
    expect(checkProof("{}", message, ecdsaInfo).problem).toBe(
      'the proof file needs "message" and "signature" (hex)',
    );
    expect(checkProof(file(ecdsa), message, null).problem).toBe(
      "the mirror node does not know the buyer's account",
    );
    expect(checkProof(file(ecdsa), message, { _type: "ProtobufEncoded", key: "x" }).problem).toBe(
      "the buyer's account key type ProtobufEncoded is not supported for proofs",
    );
  });
});

describe("event fields", () => {
  test("saleFields includes the payment ref and price only when given", () => {
    expect(saleFields({ seller: SELLER, buyer: BUYER, payment: "off_chain" })).toEqual({
      seller_id: SELLER, buyer_id: BUYER, payment: "off_chain",
    });
    expect(
      saleFields({ seller: SELLER, buyer: BUYER, payment: "on_chain", paymentTx: NFT_TX, soldFor: "5", currency: "HBAR" }),
    ).toEqual({
      seller_id: SELLER, buyer_id: BUYER, payment: "on_chain", payment_ref: NFT_TX, sold_for: "5", currency: "HBAR",
    });
  });

  test("deliveredFields says whether there is a signed proof", () => {
    const input = { buyer: BUYER, method: "in_person", deliveredAt: new Date("2026-11-05T15:00:00.500Z") };
    expect(deliveredFields(input)).toEqual({
      buyer_id: BUYER, method: "in_person", delivered_at: "2026-11-05T15:00:00Z", proof: "none",
    });
    expect(deliveredFields(input, "ab".repeat(32))).toMatchObject({ proof: "signed", proof_hash: "ab".repeat(32) });
  });
});
