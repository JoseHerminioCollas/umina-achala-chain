import {
  canonicalHbar,
  currentListing,
  displayEnvProblems,
  displayFields,
  listingProblem,
  parseDisplayArgs,
  timestampNanos,
  tokenClasses,
} from "../src/display/lib.js";
import { PrivateKey } from "@hashgraph/sdk";

const TOKEN = "0.0.2002";

describe("parseDisplayArgs", () => {
  test("listed takes a serial and a price", () => {
    const input = parseDisplayArgs(["listed", "7", "--price", "50.5", "--dry-run"]);
    expect(input.problems).toEqual([]);
    expect(input).toMatchObject({ command: "listed", serial: "7", price: "50.5", tokenClass: "umina", dryRun: true });
  });

  test("listed needs a positive HBAR price with at most 8 decimals", () => {
    expect(parseDisplayArgs(["listed", "7"]).problems).toEqual([
      "--price is required: the asking price in HBAR",
    ]);
    for (const price of ["0", "abc", "1.123456789", "1e3"]) {
      expect(parseDisplayArgs(["listed", "7", "--price", price]).problems).toEqual([
        `--price must be a positive amount in HBAR, at most 8 decimals, got "${price}"`,
      ]);
    }
    // a negative price never reaches the check: the parser refuses it
    expect(parseDisplayArgs(["listed", "7", "--price", "-1"]).problems).toHaveLength(1);
  });

  test("unlisted takes an optional reason, and no price", () => {
    expect(parseDisplayArgs(["unlisted", "7", "--reason", "Photo retake"]).problems).toEqual([]);
    expect(parseDisplayArgs(["unlisted", "7", "--price", "5"]).problems).toEqual([
      "--price is only used with listed",
    ]);
    expect(parseDisplayArgs(["unlisted", "7", "--reason", " "]).problems).toEqual(["--reason is empty"]);
    expect(parseDisplayArgs(["unlisted", "7", "--reason", "x".repeat(201)]).problems).toEqual([
      "--reason is 201 characters, at most 200",
    ]);
    expect(parseDisplayArgs(["listed", "7", "--price", "5", "--reason", "x"]).problems).toEqual([
      "--reason is only used with unlisted",
    ]);
  });

  test("the serial must be a positive integer", () => {
    for (const serial of [undefined, "0", "1.5", "x"]) {
      const argv = ["unlisted", ...(serial === undefined ? [] : [serial])];
      expect(parseDisplayArgs(argv).problems).toEqual(["give the NFT serial number as a positive integer"]);
    }
    // "-2" is read as an option, and refused as one
    expect(parseDisplayArgs(["unlisted", "-2"]).problems[0]).toMatch(/Unknown option '-2'/);
  });

  test("--token must name a class", () => {
    expect(parseDisplayArgs(["unlisted", "7", "--token", "achala"]).tokenClass).toBe("achala");
    expect(parseDisplayArgs(["unlisted", "7", "--token", "ring"]).problems).toEqual([
      '--token must be umina or achala, got "ring"',
    ]);
  });

  test("status takes only --token, and covers both classes without it", () => {
    const status = parseDisplayArgs(["status"]);
    expect(status.problems).toEqual([]);
    expect(tokenClasses(status)).toEqual(["umina", "achala"]);
    expect(tokenClasses(parseDisplayArgs(["status", "--token", "achala"]))).toEqual(["achala"]);
    expect(parseDisplayArgs(["status", "7", "--dry-run"]).problems).toEqual([
      "status takes no serial: it shows every item the Treasury holds",
      "--dry-run is not used with status",
    ]);
  });

  test("an unknown command, option or extra argument is a problem", () => {
    expect(parseDisplayArgs(["list", "7"]).problems).toEqual([
      "give the command: listed, unlisted, status (see --help)",
    ]);
    expect(parseDisplayArgs(["listed", "7", "--prise", "5"]).problems[0]).toMatch(/Unknown option '--prise'/);
    expect(parseDisplayArgs(["unlisted", "7", "8"]).problems).toEqual(["too many arguments: 8"]);
  });
});

describe("displayEnvProblems", () => {
  const key = PrivateKey.generateECDSA().toStringDer();
  const env = {
    OPERATOR_ID: "0.0.1001",
    OPERATOR_KEY: key,
    TREASURY_ID: "0.0.1001",
    UMINA_TOKEN_ID: TOKEN,
    ACHALA_TOKEN_ID: "0.0.2003",
    HCS_TOPIC_ID: "0.0.3003",
    HCS_DISPLAY_TOPIC_ID: "0.0.3004",
  };

  test("a complete environment has no problems", () => {
    expect(displayEnvProblems(env, "listed")).toEqual([]);
  });

  test("both topics and both tokens are needed", () => {
    const { HCS_DISPLAY_TOPIC_ID, ACHALA_TOKEN_ID, ...rest } = env;
    expect(displayEnvProblems(rest, "listed")).toEqual([
      "ACHALA_TOKEN_ID is not set",
      "HCS_DISPLAY_TOPIC_ID is not set",
    ]);
  });

  test("status reads only, so it needs no operator key or submit key", () => {
    const { OPERATOR_ID, OPERATOR_KEY, ...rest } = env;
    expect(displayEnvProblems({ ...rest, HCS_SUBMIT_KEY: "bad" }, "status")).toEqual([]);
    expect(displayEnvProblems({ ...env, HCS_SUBMIT_KEY: "bad" }, "unlisted")).toEqual([
      "HCS_SUBMIT_KEY is not an ECDSA private key (hex or DER)",
    ]);
  });
});

describe("prices and timestamps", () => {
  test("canonicalHbar writes an amount the short way", () => {
    expect(canonicalHbar("50.50")).toBe("50.5");
    expect(canonicalHbar("007")).toBe("7");
    expect(canonicalHbar("0.00000001")).toBe("0.00000001");
    expect(canonicalHbar("120.00")).toBe("120");
  });

  test("timestampNanos compares consensus timestamps exactly", () => {
    expect(timestampNanos("1700000000.000000002") > timestampNanos("1700000000.000000001")).toBe(true);
    expect(timestampNanos("1700000000.5")).toBe(1_700_000_000_500_000_000n);
    expect(timestampNanos("1700000001")).toBe(1_700_000_001_000_000_000n);
  });
});

describe("currentListing", () => {
  const ev = (seq, ts, event, extra = {}) => ({
    sequence_number: seq,
    consensus_timestamp: ts,
    event: { event, token_id: TOKEN, serials: ["7"], ...extra },
  });

  test("not listed when there is no display event", () => {
    expect(currentListing([], TOKEN, 7, null)).toEqual({ listed: false });
  });

  test("the latest LISTED or UNLISTED of this item decides", () => {
    const events = [ev(1, "10.0", "LISTED", { price: "50" }), ev(2, "11.0", "LISTED", { price: "60" })];
    expect(currentListing(events, TOKEN, 7, null)).toEqual({ listed: true, price: "60", sequence_number: 2 });
    expect(currentListing([...events, ev(3, "12.0", "UNLISTED")], TOKEN, 7, null)).toEqual({ listed: false });
  });

  test("other items and other events do not count", () => {
    const events = [
      ev(1, "10.0", "LISTED", { price: "50" }),
      { sequence_number: 2, consensus_timestamp: "11.0", event: { event: "UNLISTED", token_id: TOKEN, serials: ["8"] } },
      { sequence_number: 3, consensus_timestamp: "12.0", event: { event: "UNLISTED", token_id: "0.0.9", serials: ["7"] } },
      ev(4, "13.0", "HIDDEN"),
    ];
    expect(currentListing(events, TOKEN, "7", null).listed).toBe(true);
  });

  test("a listing made before the NFT last arrived in the Treasury does not count", () => {
    const events = [ev(1, "10.0", "LISTED", { price: "50" })];
    expect(currentListing(events, TOKEN, 7, "10.5")).toEqual({ listed: false });
    expect(currentListing([...events, ev(2, "11.0", "LISTED", { price: "55" })], TOKEN, 7, "10.5")).toEqual({
      listed: true,
      price: "55",
      sequence_number: 2,
    });
  });

  test("an event without a consensus timestamp does not count once the arrival is known", () => {
    const events = [{ sequence_number: 1, event: { event: "LISTED", token_id: TOKEN, serials: ["7"], price: "5" } }];
    expect(currentListing(events, TOKEN, 7, "1.0").listed).toBe(false);
  });
});

describe("listingProblem and displayFields", () => {
  test("listing again at the same price is refused; another price is not", () => {
    const listing = { listed: true, price: "50.5", sequence_number: 4 };
    expect(listingProblem({ command: "listed", price: "50.50" }, listing)).toBe(
      "already listed at 50.5 HBAR (display event #4); give another --price to change it",
    );
    expect(listingProblem({ command: "listed", price: "60" }, listing)).toBeNull();
    expect(listingProblem({ command: "listed", price: "60" }, { listed: false })).toBeNull();
  });

  test("only a listed item can be unlisted", () => {
    expect(listingProblem({ command: "unlisted" }, { listed: false })).toBe(
      "it is not listed now, so there is nothing to unlist",
    );
    expect(listingProblem({ command: "unlisted" }, { listed: true, price: "5" })).toBeNull();
  });

  test("LISTED carries the price in HBAR; UNLISTED an optional reason", () => {
    expect(displayFields({ command: "listed", price: "050.50" })).toEqual({ price: "50.5", currency: "HBAR" });
    expect(displayFields({ command: "unlisted", reason: " Photo retake " })).toEqual({ reason: "Photo retake" });
    expect(displayFields({ command: "unlisted" })).toEqual({});
  });
});
