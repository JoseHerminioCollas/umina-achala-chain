/**
 * @file topic/lib.js
 * @description Environment checks and the TopicCreateTransaction for the
 * Umiña Achala HCS topics, used by createTopic.js and kept apart from it
 * so they can be tested without a network (umina-achala-chain#9).
 *
 * The data model (#10) has two topics: provenance (MINT, SALE and the item's
 * other history) and display (what the site shows and what is for sale).
 */

import { TopicCreateTransaction } from "@hashgraph/sdk";
import { parseEcdsaKey } from "../keys.js";
import { topicInfo } from "../mirror.js";

/** The two topics: the env variable that holds each ID, and its memo. */
export const TOPICS = {
  provenance: { envVar: "HCS_TOPIC_ID", memo: "Umiña Achala provenance" },
  display: { envVar: "HCS_DISPLAY_TOPIC_ID", memo: "Umiña Achala display" },
};

const ACCOUNT_ID = /^0\.0\.\d+$/;
const KEY_NAMES = ["OPERATOR_KEY", "HCS_SUBMIT_KEY", "HCS_ADMIN_KEY"];

/**
 * Checks the topic kind and the environment and returns the problems found,
 * each naming what is wrong. An empty array means the script can run.
 * HCS_SUBMIT_KEY and HCS_ADMIN_KEY are required here, so a topic is never
 * created that anyone could post to or that could not be managed later.
 */
export function validateTopicEnv(env, kind) {
  const problems = [];
  if (!TOPICS[kind]) {
    problems.push(`give the topic kind: ${Object.keys(TOPICS).join(" or ")}`);
  }
  if (!env.OPERATOR_ID) problems.push("OPERATOR_ID is missing");
  else if (!ACCOUNT_ID.test(env.OPERATOR_ID))
    problems.push(`OPERATOR_ID must look like 0.0.1234, got "${env.OPERATOR_ID}"`);
  for (const name of KEY_NAMES) {
    if (!env[name]) {
      problems.push(`${name} is missing`);
      continue;
    }
    try {
      parseEcdsaKey(env[name]);
    } catch {
      problems.push(`${name} is not an ECDSA private key (hex or DER)`);
    }
  }
  return problems;
}

/**
 * Builds the (unfrozen) transaction. Only public keys are set on the topic.
 * The admin key must also sign it; the submit key does not.
 */
export function buildTopicTransaction(env, kind) {
  return new TopicCreateTransaction()
    .setTopicMemo(TOPICS[kind].memo)
    .setSubmitKey(parseEcdsaKey(env.HCS_SUBMIT_KEY).publicKey)
    .setAdminKey(parseEcdsaKey(env.HCS_ADMIN_KEY).publicKey)
    .setAutoRenewAccountId(env.OPERATOR_ID);
}

/** Plain-text summary of the topic parameters, with no keys in it. */
export function describeTopic(env, kind) {
  return {
    kind,
    memo: TOPICS[kind].memo,
    saveAs: TOPICS[kind].envVar,
    autoRenewAccount: env.OPERATOR_ID,
    submitKey: "public key of HCS_SUBMIT_KEY",
    adminKey: "public key of HCS_ADMIN_KEY",
    sameKeyAsOperator: {
      submit: env.HCS_SUBMIT_KEY === env.OPERATOR_KEY,
      admin: env.HCS_ADMIN_KEY === env.OPERATOR_KEY,
    },
  };
}

/**
 * Returns a problem message when the env variable for this kind already names
 * a topic that exists (and is not deleted) on the mirror node, or null. A
 * placeholder ID that does not exist is not a problem.
 */
export async function existingTopicProblem(env, kind, fetchFn = fetch) {
  const { envVar } = TOPICS[kind];
  const topicId = env[envVar];
  if (!topicId || !ACCOUNT_ID.test(topicId)) return null;
  const info = await topicInfo(topicId, fetchFn);
  if (!info || info.deleted) return null;
  return `${envVar} already names topic ${topicId} ("${info.memo}"). Use --force to create a new one anyway.`;
}
