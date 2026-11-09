/**
 * @file provenance.js
 * @description Reading the provenance topic, shared by the scripts that check
 * an item against it before acting (umina-achala-chain#29): the read with one
 * error message, and the mounted-stone check with the token IDs from the
 * environment (#24).
 */

import { topicEvents } from "./mirror.js";
import { mountedProblem } from "./mint/achala.js";

/**
 * Reads every event on the provenance topic (HCS_TOPIC_ID) from the mirror
 * node.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ events: object[], problem?: undefined } | { problem: string, events?: undefined }>}
 */
export async function readProvenance(env, read = topicEvents) {
  try {
    return { events: await read(env.HCS_TOPIC_ID) };
  } catch (err) {
    return { problem: `cannot read HCS_TOPIC_ID ${env.HCS_TOPIC_ID}: ${err.message}` };
  }
}

/** The token IDs mountedProblem and achalaSalePlan need, from the environment, for one Umiña or Achala serial. */
export function mountIds(env, serial) {
  return { uminaTokenId: env.UMINA_TOKEN_ID, achalaTokenId: env.ACHALA_TOKEN_ID, serial };
}

/**
 * A problem when the Umiña serial is mounted in an Achala that still exists,
 * or null: mountedProblem with the token IDs from the environment.
 */
export function mountedStoneProblem(events, env, serial) {
  return mountedProblem(events, mountIds(env, serial));
}
