/**
 * @file createTopic.js
 * @description Creates an Umiña Achala HCS topic on Hedera: the
 * provenance topic (HCS_TOPIC_ID) or the display topic (HCS_DISPLAY_TOPIC_ID),
 * with a submit key so only the project can post events, an admin key so the
 * topic can be updated or deleted, and the operator as auto-renew account
 * (umina-achala-chain#9).
 *
 * Run from the command line:
 * node src/topic/createTopic.js <provenance|display> [env-file] [--force] [--dry-run]
 *
 * The network is NETWORK (testnet when unset, see src/network.js) and the env
 * file defaults to its own (.env.testnet); a file given must name the network.
 * The topic kind is required, so a
 * topic is never created without saying which. --dry-run checks the
 * environment and prints the topic parameters without keys and without
 * touching the network. A real run first checks the mirror node and refuses
 * when the env variable already names an existing topic; --force skips that.
 */

import {
  buildTopicTransaction,
  describeTopic,
  existingTopicProblem,
  TOPICS,
  validateTopicEnv,
} from "./lib.js";
import { parseEcdsaKey } from "../keys.js";
import { envFileProblem, NETWORKS, networkName } from "../network.js";
import { fail, loadEnv, runScript } from "../script.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const [kind, envArg] = args.filter((a) => !a.startsWith("--"));
const envFile = envArg ?? NETWORKS[networkName()]?.envFile;
// Refuse a file meant for another network rather than send its credentials
// to the wrong one.
const fileProblem = envFile ? envFileProblem(envFile) : null;
if (!fileProblem) loadEnv(envFile);

runScript("Topic creation failed", async (session) => {
  if (fileProblem) return fail([fileProblem]);

  // --- 1. Check the topic kind and the environment ---
  const problems = validateTopicEnv(process.env, kind);
  if (problems.length) return fail(problems, `Problems in ${envFile}`);
  console.log(`🚀 Creating the Umiña Achala ${kind} topic...`);

  // --- 2. Build the transaction ---
  const transaction = buildTopicTransaction(process.env, kind);
  if (dryRun) {
    console.log("Dry run, nothing sent:");
    console.log(describeTopic(process.env, kind));
    return;
  }

  // --- 3. Refuse to replace a topic that already exists ---
  if (!force) {
    const existing = await existingTopicProblem(process.env, kind);
    if (existing) {
      console.error(`❌ ${existing}`);
      process.exitCode = 1;
      return;
    }
  }

  // --- 4. Connect to Hedera, sign and execute ---
  // The operator pays; the admin key must sign the creation.
  const client = session.connect();
  const frozen = await transaction.freezeWith(client);
  await frozen.sign(parseEcdsaKey(process.env.HCS_ADMIN_KEY));
  const response = await frozen.execute(client);
  const receipt = await response.getReceipt(client);
  console.log("-----------------------------------");
  console.log(`✅ Success! Umiña Achala ${kind} topic ID: ${receipt.topicId}`);
  console.log("-----------------------------------");
  console.log(`SAVE THIS ID IN ${envFile} AS: ${TOPICS[kind].envVar}`);
});
