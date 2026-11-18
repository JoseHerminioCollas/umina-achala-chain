import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";
import { mockMirror, restoreMirror } from "../testHelpers/mockMirror.js";
import { actualSdk } from "../testHelpers/actualSdk.js";
import {
  hbarToTinybars,
  parseTransferArgs,
  recordCommand,
  testnetOnlyProblem,
  transferProblems,
} from "../src/testnet/lib.js";

// The testnet-only wallet-to-wallet transfer (umina-achala-chain#40): the
// checks, then the script itself with Hedera and dotenv mocked.

const merchantKey = PrivateKey.generateECDSA();
const buyerKey = PrivateKey.generateECDSA();
const pub = (k) => k.publicKey.toString();

const baseEnv = () => ({
  MERCHANT_ID: "0.0.4004",
  MERCHANT_KEY: merchantKey.toStringDer(),
  BUYER_ID: "0.0.6006",
  BUYER_KEY: buyerKey.toStringDer(),
  UMINA_TOKEN_ID: "0.0.2002",
  ACHALA_TOKEN_ID: "0.0.8008",
  HCS_TOPIC_ID: "0.0.3003",
});

describe("testnet/lib.js", () => {
  test("testnet only: any other NETWORK is refused", () => {
    expect(testnetOnlyProblem({ NETWORK: "testnet" })).toBeNull();
    expect(testnetOnlyProblem({ NETWORK: "mainnet" })).toContain("testnet-only tool");
    expect(testnetOnlyProblem({})).toContain("testnet-only tool");
  });

  test("hbarToTinybars: positive amounts with at most 8 decimals", () => {
    expect(hbarToTinybars("10")).toBe(1_000_000_000n);
    expect(hbarToTinybars("0.00000001")).toBe(1n);
    expect(hbarToTinybars("0")).toBeNull();
    expect(hbarToTinybars("1.123456789")).toBeNull();
    expect(hbarToTinybars("-1")).toBeNull();
  });

  test("parses the serials and wallets; --to defaults to the other wallet", () => {
    expect(parseTransferArgs(["5", "--from", "merchant"])).toMatchObject({
      serials: ["5"],
      from: "merchant",
      to: "buyer",
      tokenClass: "umina",
      tinybars: 0n,
      dryRun: false,
      problems: [],
    });
    expect(parseTransferArgs(["3,4", "--from", "buyer", "--hbar", "10", "--dry-run"])).toMatchObject({
      serials: ["3", "4"],
      to: "merchant",
      tinybars: 1_000_000_000n,
      dryRun: true,
      problems: [],
    });
  });

  test("lists every argument problem", () => {
    expect(parseTransferArgs(["0,x", "--from", "seller"]).problems).toEqual([
      'serials must be positive integers, got "0,x"',
      "--from must be merchant or buyer",
    ]);
    expect(parseTransferArgs(["2,3", "--token", "achala", "--from", "buyer", "--to", "buyer"]).problems).toEqual([
      "give one Achala serial: it moves with its stones",
      "--from and --to must be different wallets",
    ]);
    expect(parseTransferArgs(["--from", "buyer"]).problems).toEqual([
      "give the NFT serial, or Umiña serials separated by commas (see --help)",
    ]);
    expect(parseTransferArgs(["5", "--from", "buyer", "--price", "1"]).problems[0]).toContain("--price");
  });

  test("needs both wallets' IDs and keys, the token(s) and the topic", () => {
    expect(transferProblems(baseEnv(), { from: "merchant", to: "buyer", tokenClass: "achala" })).toEqual([]);
    const env = baseEnv();
    delete env.BUYER_KEY;
    delete env.UMINA_TOKEN_ID;
    expect(transferProblems(env, { from: "merchant", to: "buyer", tokenClass: "umina" })).toEqual([
      "BUYER_KEY is not set",
      "UMINA_TOKEN_ID is not set",
    ]);
  });

  test("the recordEvent.js command: on_chain with the HBAR paid, else off_chain to fill in", () => {
    const base = { serial: "5", sellerId: "0.0.4004", buyerId: "0.0.6006", txId: "0.0.4004@1.2" };
    expect(recordCommand({ ...base, tokenClass: "umina", hbar: "10" })).toBe(
      "NETWORK=testnet node src/record/recordEvent.js sale 5 --seller 0.0.4004 --buyer 0.0.6006 --nft-tx 0.0.4004@1.2 --payment on_chain --sold-for 10",
    );
    expect(recordCommand({ ...base, tokenClass: "achala", hbar: null })).toContain(
      "--payment off_chain --sold-for <amount> --currency <code> --token achala",
    );
  });
});

describe("transferBetweenWallets.js", () => {
  const env = { ...process.env };
  const argv = [...process.argv];
  const calls = {};

  function mockDependencies({ topicEvents = [], nfts = {}, holder = "0.0.4004", fees = [] } = {}) {
    calls.mirror = mockMirror(topicEvents, { nfts, holder });
    calls.tx = null;
    calls.operator = null;
    calls.close = jest.fn();
    const client = {
      setOperator: jest.fn((id, key) => ((calls.operator = [String(id), pub(key)]), client)),
      close: calls.close,
    };
    jest.doMock("dotenv", () => ({ __esModule: true, default: { config: jest.fn() } }));
    jest.doMock("@hashgraph/sdk", () => ({
      ...actualSdk(),
      Client: { forTestnet: jest.fn(() => client) },
      TransferTransaction: jest.fn().mockImplementation(() => {
        const record = { calls: [], signed: [] };
        calls.tx = record;
        const tx = new Proxy(
          {},
          {
            get(_, prop) {
              if (prop === "then") return undefined;
              if (prop === "sign") return async (k) => (record.signed.push(pub(k)), tx);
              if (prop === "execute")
                return async () => ({
                  transactionId: { toString: () => "0.0.4004@1700000000.1" },
                  getReceipt: async () => ({ status: "SUCCESS" }),
                  getRecord: async () => ({ assessedCustomFees: fees }),
                });
              return (...a) => (record.calls.push([prop, ...a]), tx);
            },
          },
        );
        return tx;
      }),
    }));
  }

  async function runScript(...args) {
    process.argv = ["node", "src/testnet/transferBetweenWallets.js", ...args];
    await import("../src/testnet/transferBetweenWallets.js");
    await new Promise((resolve) => setImmediate(resolve));
  }

  const callsTo = (method) => calls.tx.calls.filter(([m]) => m === method).map(([, ...a]) => a);
  const logged = () => console.log.mock.calls.map((c) => c.join(" ")).join("\n");

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, baseEnv());
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "table").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    restoreMirror();
    process.env = { ...env };
    process.argv = [...argv];
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("no HBAR: the sender is the operator, the receiver signs, the fallback fee is reported", async () => {
    mockDependencies({
      fees: [{ amount: { toString: () => "4500000000" }, feeCollectorAccountId: "0.0.1001", payerAccountIds: ["0.0.6006"] }],
    });
    await runScript("5", "--from", "merchant");

    expect(calls.operator).toEqual(["0.0.4004", pub(merchantKey)]);
    expect(calls.tx.signed).toEqual([pub(buyerKey)]);
    const [[nftId, from, to]] = callsTo("addNftTransfer");
    expect([String(nftId), String(from), String(to)]).toEqual(["0.0.2002/5", "0.0.4004", "0.0.6006"]);
    expect(callsTo("addHbarTransfer")).toEqual([]);
    expect(logged()).toContain("Custom fee: 45 ℏ to 0.0.1001, paid by 0.0.6006");
    expect(logged()).toContain("--payment off_chain --sold-for <amount> --currency <code>");
    expect(calls.close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("--hbar: the receiver pays the sender in the same transaction", async () => {
    mockDependencies({ holder: "0.0.6006" });
    await runScript("3,4", "--from", "buyer", "--hbar", "0.00000001");

    expect(callsTo("addNftTransfer").map((a) => a.map(String))).toEqual([
      ["0.0.2002/3", "0.0.6006", "0.0.4004"],
      ["0.0.2002/4", "0.0.6006", "0.0.4004"],
    ]);
    expect(callsTo("addHbarTransfer").map(([id, h]) => [String(id), h.toTinybars().toString()])).toEqual([
      ["0.0.4004", "-1"],
      ["0.0.6006", "1"],
    ]);
    expect(calls.tx.signed).toEqual([pub(merchantKey)]);
    expect(logged()).toContain("No custom fee assessed.");
    expect(logged()).toContain("recordEvent.js records one NFT per SALE");
  });

  const topic = [
    { event: "MINT", stone_id: "UMINA-2026-CH-03", token_id: "0.0.2002", serials: ["3"] },
    {
      event: "MINT",
      stone_id: "ACHALA-2026-RI-01",
      token_id: "0.0.8008",
      serials: ["1"],
      from_stone_ids: ["UMINA-2026-CH-03"],
    },
  ];

  test("--token achala moves the piece with its stones", async () => {
    mockDependencies({ topicEvents: topic });
    await runScript("1", "--token", "achala", "--from", "merchant", "--hbar", "10");

    expect(callsTo("addNftTransfer").map((a) => a.map(String))).toEqual([
      ["0.0.8008/1", "0.0.4004", "0.0.6006"],
      ["0.0.2002/3", "0.0.4004", "0.0.6006"],
    ]);
    expect(logged()).toContain("--payment on_chain --sold-for 10 --token achala");
  });

  test("refuses a stone mounted in an Achala, and sends nothing", async () => {
    mockDependencies({ topicEvents: topic });
    await runScript("3", "--from", "merchant");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("is mounted in Achala ACHALA-2026-RI-01"));
    expect(calls.tx).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  test("refuses when the sender does not hold the NFT, also on --dry-run", async () => {
    mockDependencies({ holder: "0.0.1001" });
    await runScript("5", "--from", "merchant", "--dry-run");

    expect(console.error).toHaveBeenCalledWith(
      "   - 0.0.2002/5 is held by 0.0.1001, not the merchant 0.0.4004. Check the serial and --from.",
    );
    expect(process.exitCode).toBe(1);
  });

  test("--dry-run reads the topic and the holder and sends nothing", async () => {
    mockDependencies();
    await runScript("5", "--from", "merchant", "--dry-run");

    expect(calls.mirror).toEqual([
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3003",
      "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.3003/messages?limit=100&order=asc",
      "https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.2002/nfts/5",
    ]);
    expect(calls.tx).toBeNull();
    expect(console.log).toHaveBeenCalledWith("Dry run, nothing sent.");
  });

  test("refuses another NETWORK without reading the env file or any key", async () => {
    mockDependencies();
    process.env.NETWORK = "mainnet";
    const dotenv = (await import("dotenv")).default;
    await runScript("5", "--from", "merchant");

    expect(dotenv.config).not.toHaveBeenCalled();
    expect(calls.tx).toBeNull();
    expect(calls.mirror).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
