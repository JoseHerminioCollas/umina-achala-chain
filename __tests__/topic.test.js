import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";
import {
  buildTopicTransaction,
  describeTopic,
  existingTopicProblem,
  TOPICS,
  validateTopicEnv,
} from "../src/topic/lib.js";
import { MIRROR_NODE } from "../src/mirror.js";

// Real SDK, no network: keys are generated and the transaction is only built.
const operatorKey = PrivateKey.generateECDSA().toStringDer();
const submitKey = PrivateKey.generateECDSA();
const adminKey = PrivateKey.generateECDSA();

function makeEnv(overrides = {}) {
  return {
    OPERATOR_ID: "0.0.1001",
    OPERATOR_KEY: operatorKey,
    HCS_SUBMIT_KEY: submitKey.toStringDer(),
    HCS_ADMIN_KEY: adminKey.toStringDer(),
    ...overrides,
  };
}

describe("validateTopicEnv", () => {
  test("accepts a complete environment for either kind", () => {
    expect(validateTopicEnv(makeEnv(), "provenance")).toEqual([]);
    expect(validateTopicEnv(makeEnv(), "display")).toEqual([]);
  });

  test("accepts the operator key as submit and admin key (one key on testnet)", () => {
    const env = makeEnv({ HCS_SUBMIT_KEY: operatorKey, HCS_ADMIN_KEY: operatorKey });
    expect(validateTopicEnv(env, "provenance")).toEqual([]);
  });

  test("requires the topic kind", () => {
    expect(validateTopicEnv(makeEnv(), undefined)).toEqual([
      "give the topic kind: provenance or display",
    ]);
    expect(validateTopicEnv(makeEnv(), "sales")).toEqual([
      "give the topic kind: provenance or display",
    ]);
  });

  test("requires the submit and admin keys", () => {
    const env = makeEnv();
    delete env.HCS_SUBMIT_KEY;
    delete env.HCS_ADMIN_KEY;
    expect(validateTopicEnv(env, "provenance")).toEqual([
      "HCS_SUBMIT_KEY is missing",
      "HCS_ADMIN_KEY is missing",
    ]);
  });

  test("names a key that is not ECDSA and an operator ID that is not 0.0.N", () => {
    const env = makeEnv({
      OPERATOR_ID: "1001",
      HCS_ADMIN_KEY: PrivateKey.generateED25519().toStringDer(),
    });
    expect(validateTopicEnv(env, "provenance")).toEqual([
      'OPERATOR_ID must look like 0.0.1234, got "1001"',
      "HCS_ADMIN_KEY is not an ECDSA private key (hex or DER)",
    ]);
  });
});

describe("buildTopicTransaction", () => {
  test("sets the memo, the public submit and admin keys, and the auto-renew account", () => {
    const tx = buildTopicTransaction(makeEnv(), "provenance");
    expect(tx.topicMemo).toBe("Umiña Achala provenance");
    expect(tx.submitKey.toString()).toBe(submitKey.publicKey.toString());
    expect(tx.adminKey.toString()).toBe(adminKey.publicKey.toString());
    expect(tx.autoRenewAccountId.toString()).toBe("0.0.1001");
  });

  test("uses the display memo for the display topic", () => {
    expect(buildTopicTransaction(makeEnv(), "display").topicMemo).toBe("Umiña Achala display");
  });
});

describe("describeTopic", () => {
  test("lists the parameters and contains no key material", () => {
    const env = makeEnv();
    const summary = describeTopic(env, "display");
    expect(summary.saveAs).toBe("HCS_DISPLAY_TOPIC_ID");
    const text = JSON.stringify(summary);
    for (const k of [env.OPERATOR_KEY, env.HCS_SUBMIT_KEY, env.HCS_ADMIN_KEY]) {
      expect(text).not.toContain(k);
    }
    expect(text).not.toContain(submitKey.publicKey.toString());
  });

  test("says whether the keys are the operator key", () => {
    const env = makeEnv({ HCS_SUBMIT_KEY: operatorKey });
    expect(describeTopic(env, "provenance").sameKeyAsOperator).toEqual({
      submit: true,
      admin: false,
    });
  });
});

describe("existingTopicProblem", () => {
  const reply = (status, body) =>
    jest.fn().mockResolvedValue({ ok: status === 200, status, json: async () => body });

  test("no problem when the env variable is empty or not a topic ID", async () => {
    const fetchFn = reply(200, {});
    expect(await existingTopicProblem({}, "provenance", fetchFn)).toBeNull();
    expect(await existingTopicProblem({ HCS_TOPIC_ID: "tbd" }, "provenance", fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("no problem for a placeholder ID that does not exist", async () => {
    const fetchFn = reply(404);
    expect(
      await existingTopicProblem({ HCS_TOPIC_ID: "0.0.1234" }, "provenance", fetchFn),
    ).toBeNull();
    expect(fetchFn).toHaveBeenCalledWith(`${MIRROR_NODE}/api/v1/topics/0.0.1234`);
  });

  test("no problem for a deleted topic", async () => {
    const fetchFn = reply(200, { deleted: true, memo: "old" });
    expect(
      await existingTopicProblem({ HCS_TOPIC_ID: "0.0.3003" }, "provenance", fetchFn),
    ).toBeNull();
  });

  test("names an existing topic in the variable for that kind", async () => {
    const fetchFn = reply(200, { deleted: false, memo: "Umiña Achala display" });
    expect(
      await existingTopicProblem({ HCS_DISPLAY_TOPIC_ID: "0.0.3004" }, "display", fetchFn),
    ).toBe(
      'HCS_DISPLAY_TOPIC_ID already names topic 0.0.3004 ("Umiña Achala display"). Use --force to create a new one anyway.',
    );
  });

  test("each kind has its own env variable", () => {
    expect(TOPICS.provenance.envVar).toBe("HCS_TOPIC_ID");
    expect(TOPICS.display.envVar).toBe("HCS_DISPLAY_TOPIC_ID");
  });
});
