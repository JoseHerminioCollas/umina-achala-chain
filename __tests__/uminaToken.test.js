import { PrivateKey, TokenSupplyType, TokenType } from "@hashgraph/sdk";
import {
  buildTokenTransaction,
  describeToken,
  loadKeys,
  validateEnv,
} from "../src/uminaToken.js";

// Real SDK, no network: keys are generated and the transaction is only built.
const operatorKey = PrivateKey.generateECDSA().toStringDer();

function makeEnv(overrides = {}) {
  return {
    OPERATOR_ID: "0.0.1001",
    OPERATOR_KEY: operatorKey,
    TREASURY_ID: "0.0.1001",
    ADMIN_KEY: operatorKey,
    SUPPLY_KEY: operatorKey,
    FEE_SCHEDULE_KEY: operatorKey,
    PAUSE_KEY: operatorKey,
    WIPE_KEY: operatorKey,
    ...overrides,
  };
}

describe("validateEnv", () => {
  test("accepts a complete environment with one key for every role", () => {
    expect(validateEnv(makeEnv())).toEqual([]);
  });

  test("accepts raw 64-character hex keys as well as DER", () => {
    const raw = PrivateKey.generateECDSA().toStringRaw();
    expect(validateEnv(makeEnv({ ADMIN_KEY: raw }))).toEqual([]);
  });

  test("names each missing variable", () => {
    const env = makeEnv();
    delete env.SUPPLY_KEY;
    delete env.OPERATOR_ID;
    const problems = validateEnv(env);
    expect(problems).toContain("SUPPLY_KEY is missing");
    expect(problems).toContain("OPERATOR_ID is missing");
  });

  test("rejects an account id that is not 0.0.N", () => {
    const problems = validateEnv(makeEnv({ TREASURY_ID: "1234" }));
    expect(problems.join()).toMatch(/TREASURY_ID must look like 0\.0\.1234/);
  });

  test("rejects a key that is not an ECDSA private key", () => {
    const problems = validateEnv(makeEnv({ WIPE_KEY: "not-a-key" }));
    expect(problems).toContain("WIPE_KEY is not an ECDSA private key (hex or DER)");
  });

  test("rejects an ED25519 key for an ECDSA role", () => {
    const ed = PrivateKey.generateED25519().toStringDer();
    expect(validateEnv(makeEnv({ PAUSE_KEY: ed }))).toContain(
      "PAUSE_KEY is not an ECDSA private key (hex or DER)",
    );
  });

  test("requires TREASURY_KEY only when the treasury is another account", () => {
    expect(validateEnv(makeEnv({ TREASURY_ID: "0.0.2002" }))).toContain(
      "TREASURY_KEY is required when TREASURY_ID is not OPERATOR_ID",
    );
    const withKey = makeEnv({
      TREASURY_ID: "0.0.2002",
      TREASURY_KEY: PrivateKey.generateECDSA().toStringDer(),
    });
    expect(validateEnv(withKey)).toEqual([]);
  });
});

describe("buildTokenTransaction", () => {
  const env = makeEnv();
  const keys = loadKeys(env);
  const tx = buildTokenTransaction(env, keys);

  test("is a non-fungible token with infinite supply and none minted", () => {
    expect(tx.tokenType).toBe(TokenType.NonFungibleUnique);
    expect(tx.supplyType).toBe(TokenSupplyType.Infinite);
    expect(tx.initialSupply.toNumber()).toBe(0);
    expect(tx.decimals.toNumber()).toBe(0);
  });

  test("is named Umiña / UMINA with the provenance memo", () => {
    expect(tx.tokenName).toBe("Umiña");
    expect(tx.tokenSymbol).toBe("UMINA");
    expect(tx.tokenMemo).toBe(
      "Umiña Achala: Authentic Peruvian Stones and Minerals",
    );
  });

  test("sets the treasury and the auto-renew account to TREASURY_ID", () => {
    expect(tx.treasuryAccountId.toString()).toBe("0.0.1001");
    expect(tx.autoRenewAccountId.toString()).toBe("0.0.1001");
  });

  test("sets all six role keys as public keys, wipe and metadata included", () => {
    const publicKey = PrivateKey.fromStringECDSA(operatorKey).publicKey.toString();
    for (const role of [
      tx.adminKey,
      tx.supplyKey,
      tx.feeScheduleKey,
      tx.pauseKey,
      tx.wipeKey,
      tx.metadataKey,
    ]) {
      expect(role.toString()).toBe(publicKey);
    }
  });

  test("has a single 5% royalty to the treasury and no fallback fee", () => {
    expect(tx.customFees).toHaveLength(1);
    const [fee] = tx.customFees;
    expect(fee.numerator.toNumber()).toBe(5);
    expect(fee.denominator.toNumber()).toBe(100);
    expect(fee.feeCollectorAccountId.toString()).toBe("0.0.1001");
    expect(fee.fallbackFee).toBeNull();
  });

  test("METADATA_KEY, when set, replaces the admin key as the metadata key", () => {
    const other = PrivateKey.generateECDSA();
    const custom = makeEnv({ METADATA_KEY: other.toStringDer() });
    const built = buildTokenTransaction(custom, loadKeys(custom));
    expect(built.metadataKey.toString()).toBe(other.publicKey.toString());
  });
});

describe("describeToken", () => {
  test("lists the parameters and contains no key material", () => {
    const env = makeEnv();
    const text = JSON.stringify(describeToken(env, loadKeys(env)));
    expect(text).toContain("Umiña");
    expect(text).toContain("5/100");
    expect(text).not.toContain(operatorKey);
  });
});
