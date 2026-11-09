import { PrivateKey, TokenSupplyType, TokenType } from "@hashgraph/sdk";
import {
  buildTokenTransaction,
  describeToken,
  loadKeys,
  TOKEN_CLASSES,
  validateEnv,
} from "../src/token/lib.js";

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
    FALLBACK_FEE_HBAR: "38",
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
    expect(problems).toContain("SUPPLY_KEY is not set");
    expect(problems).toContain("OPERATOR_ID is not set");
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

  test("requires a positive FALLBACK_FEE_HBAR", () => {
    const env = makeEnv();
    delete env.FALLBACK_FEE_HBAR;
    expect(validateEnv(env)).toContain("FALLBACK_FEE_HBAR is not set");
    for (const bad of ["0", "-3", "abc", "3 USD", "1.123456789"]) {
      expect(validateEnv(makeEnv({ FALLBACK_FEE_HBAR: bad })).join()).toMatch(
        /FALLBACK_FEE_HBAR must be a positive HBAR amount/,
      );
    }
    expect(validateEnv(makeEnv({ FALLBACK_FEE_HBAR: "37.5" }))).toEqual([]);
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
      "Umiña: Peruvian stones",
    );
  });

  test("sets the treasury and the auto-renew account to TREASURY_ID", () => {
    expect(tx.treasuryAccountId.toString()).toBe("0.0.1001");
    expect(tx.autoRenewAccountId.toString()).toBe("0.0.1001");
  });

  test("sets the five role keys as public keys, wipe included", () => {
    const publicKey = PrivateKey.fromStringECDSA(operatorKey).publicKey.toString();
    for (const role of [
      tx.adminKey,
      tx.supplyKey,
      tx.feeScheduleKey,
      tx.pauseKey,
      tx.wipeKey,
    ]) {
      expect(role.toString()).toBe(publicKey);
    }
  });

  test("sets no metadata key, so NFT metadata is immutable", () => {
    expect(tx.metadataKey).toBeNull();
  });

  test("ignores a METADATA_KEY left in the environment", () => {
    const custom = makeEnv({ METADATA_KEY: PrivateKey.generateECDSA().toStringDer() });
    expect(buildTokenTransaction(custom, loadKeys(custom)).metadataKey).toBeNull();
  });

  test("has a single 5% royalty to the treasury with the HBAR fallback fee", () => {
    expect(tx.customFees).toHaveLength(1);
    const [fee] = tx.customFees;
    expect(fee.numerator.toNumber()).toBe(5);
    expect(fee.denominator.toNumber()).toBe(100);
    expect(fee.feeCollectorAccountId.toString()).toBe("0.0.1001");
    expect(fee.fallbackFee.hbarAmount.toTinybars().toString()).toBe("3800000000");
    expect(fee.fallbackFee.denominatingTokenId).toBeNull();
  });

  test("takes a fractional fallback fee down to the tinybar", () => {
    const custom = makeEnv({ FALLBACK_FEE_HBAR: "37.12345678" });
    const [fee] = buildTokenTransaction(custom, loadKeys(custom)).customFees;
    expect(fee.fallbackFee.hbarAmount.toTinybars().toString()).toBe("3712345678");
  });
});

describe("describeToken", () => {
  test("lists the parameters and contains no key material", () => {
    const env = makeEnv();
    const text = JSON.stringify(describeToken(env, loadKeys(env)));
    expect(text).toContain("Umiña");
    expect(text).toContain("5/100");
    expect(text).toContain("38 HBAR");
    expect(text).not.toContain('"metadata"');
    expect(text).not.toContain(operatorKey);
  });
});

describe("the Achala class (umina-achala-chain#15)", () => {
  const env = makeEnv();
  const keys = loadKeys(env);
  const achala = buildTokenTransaction(env, keys, "achala");
  const umina = buildTokenTransaction(env, keys);

  test("has its own name, symbol and memo", () => {
    expect(achala.tokenName).toBe("Achala");
    expect(achala.tokenSymbol).toBe("ACHALA");
    expect(achala.tokenMemo).toBe("Achala: Peruvian jewelry made of Umiña stones");
    expect(TOKEN_CLASSES.achala.envVar).toBe("ACHALA_TOKEN_ID");
  });

  test("shares every other setting with Umiña: type, supply, keys, no metadata key, fees", () => {
    expect(achala.tokenType).toBe(umina.tokenType);
    expect(achala.supplyType).toBe(TokenSupplyType.Infinite);
    for (const k of ["adminKey", "supplyKey", "feeScheduleKey", "pauseKey", "wipeKey"]) {
      expect(achala[k].toString()).toBe(umina[k].toString());
    }
    expect(achala.metadataKey).toBeNull();
    expect(achala.treasuryAccountId.toString()).toBe(umina.treasuryAccountId.toString());
    expect(achala.autoRenewAccountId.toString()).toBe(umina.autoRenewAccountId.toString());
    const [a] = achala.customFees;
    const [u] = umina.customFees;
    expect([a.numerator.toNumber(), a.denominator.toNumber()]).toEqual([u.numerator.toNumber(), u.denominator.toNumber()]);
    expect(a.fallbackFee.hbarAmount.toTinybars().toString()).toBe(u.fallbackFee.hbarAmount.toTinybars().toString());
  });

  test("describeToken names the class and where to save its ID", () => {
    expect(describeToken(env, keys, "achala")).toMatchObject({
      name: "Achala",
      symbol: "ACHALA",
      saveIdAs: "ACHALA_TOKEN_ID",
    });
    expect(describeToken(env, keys).saveIdAs).toBe("UMINA_TOKEN_ID");
  });
});
