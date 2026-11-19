/**
 * @file displayEvent.js
 * @description Records what UA has for sale on its site, and at what price,
 * on the HCS display topic (umina-achala-chain#43, data model #10): LISTED
 * with a price in HBAR, and UNLISTED. The site's catalog (#44) lists an item
 * only while its latest display event is a LISTED. It never moves an NFT or
 * HBAR.
 *
 * Run from the command line, with NETWORK set (testnet or mainnet; it has no
 * default and the script refuses to run without it, see src/network.js):
 *
 * NETWORK=testnet node src/display/displayEvent.js listed <serial> --price <hbar> [--token umina|achala] [--dry-run]
 * NETWORK=testnet node src/display/displayEvent.js unlisted <serial> [--reason <text>] [--token umina|achala] [--dry-run]
 * NETWORK=testnet node src/display/displayEvent.js status [--token umina|achala]
 *
 * Only items the Treasury holds are listed (Phase 2B: UA's own items, no
 * consignment). Before recording, every run checks on the mirror node that
 * the NFT exists, is not burned and is held by the Treasury; takes its
 * stone_id from its MINT on the provenance topic; and refuses an Umiña
 * mounted in an Achala that still exists (it is sold with its Achala, which is
 * listed as one item at one price).
 *
 * A listing counts only if it was made after the NFT last arrived in the
 * Treasury: an item sold and returned is not listed again by its old LISTED,
 * but listed again by hand. Listing again at the same price is refused (it
 * changes nothing); a new price is a new LISTED. Only a listed item can be
 * unlisted.
 *
 * status records nothing: it shows every item the Treasury holds, whether it
 * is listed and at what price, so what the site will show can be checked
 * before the catalog is built.
 *
 * --dry-run does all the checks, prints the event and sends nothing.
 */

import { readHolders, holderProblems } from "../nfts.js";
import { NftId, TokenId } from "@hashgraph/sdk";
import { accountNfts, latestArrival } from "../mirror.js";
import { buildEvent, loadSubmitKey, submitEvent } from "../hcs.js";
import { mountIds, readDisplay, readProvenance } from "../provenance.js";
import { mintOfSerial, mountedProblem, mountedStones } from "../mint/achala.js";
import { TOKEN_CLASSES } from "../token/lib.js";
import {
  CURRENCY,
  DISPLAY_EVENTS,
  currentListing,
  displayEnvProblems,
  displayFields,
  listingProblem,
  parseDisplayArgs,
  tokenClasses,
} from "./lib.js";
import { fail, loadEnv, runScript } from "../script.js";

const input = parseDisplayArgs(process.argv.slice(2));
loadEnv();

const USAGE = `Record what UA has for sale on its site, and at what price, on the display
topic: LISTED and UNLISTED. Only items the Treasury holds. It never moves an
NFT or HBAR.

Usage:
  NETWORK=testnet node src/display/displayEvent.js listed <serial> --price <hbar> [--token umina|achala] [--dry-run]
  NETWORK=testnet node src/display/displayEvent.js unlisted <serial> [--reason <text>] [--token umina|achala] [--dry-run]
  NETWORK=testnet node src/display/displayEvent.js status [--token umina|achala]

  listed                 list the item at --price HBAR, or change its price
  unlisted               take the item off the site; --reason is public and permanent
  status                 show every item the Treasury holds and its listing; sends nothing
  --token umina|achala   the token class (default umina; status: both)`;

/** Checks one item for listed / unlisted; returns the event or problems. */
async function prepareEvent(env, provenance, display) {
  const { tokenClass, serial, command } = input;
  const tokenId = env[TOKEN_CLASSES[tokenClass].envVar];
  const ids = mountIds(env, serial);

  // The stone_id comes from the item's MINT, never typed
  const mint = mintOfSerial(provenance, tokenId, serial);
  if (!mint) return { problems: [`${tokenId}/${serial} has no MINT on the provenance topic. Check the serial and --token.`] };

  // A stone mounted in an Achala is sold with it, so it is not listed alone.
  // It can still be unlisted, to clear a listing made before it was mounted.
  if (tokenClass === "umina" && command === "listed") {
    const mounted = mountedProblem(provenance, ids);
    if (mounted) return { problems: [mounted] };
  }

  // Held by the Treasury now (mirror node)
  const nftIds = [new NftId(TokenId.fromString(tokenId), Number(serial))];
  const held = holderProblems(nftIds, await readHolders(nftIds), env.TREASURY_ID, {
    then: "Only items the Treasury holds are listed.",
  });
  if (held.length) return { problems: held };

  // Listed now: only display events since the NFT last arrived in the Treasury count
  const since = await latestArrival(tokenId, serial, env.TREASURY_ID);
  const listing = currentListing(display, tokenId, serial, since);
  const problem = listingProblem(input, listing);
  if (problem) return { problems: [`${mint.event.stone_id} (${tokenId}/${serial}): ${problem}`] };

  return {
    listing,
    event: buildEvent(
      {
        event: DISPLAY_EVENTS[command],
        stoneId: mint.event.stone_id,
        tokenId,
        serials: [serial],
        actorId: env.OPERATOR_ID,
      },
      displayFields(input),
    ),
  };
}

/** Prints every item the Treasury holds, with its listing. */
async function showStatus(env, provenance, display) {
  const rows = [];
  for (const tokenClass of tokenClasses(input)) {
    const tokenId = env[TOKEN_CLASSES[tokenClass].envVar];
    const mounted = tokenClass === "umina" ? mountedStones(provenance, env.ACHALA_TOKEN_ID) : new Map();
    const nfts = await accountNfts(env.TREASURY_ID, tokenId);
    for (const { serial_number: serial } of nfts.sort((a, b) => a.serial_number - b.serial_number)) {
      const stoneId = mintOfSerial(provenance, tokenId, serial)?.event.stone_id ?? "(no MINT)";
      const achala = mounted.get(stoneId);
      const listing = currentListing(display, tokenId, serial, await latestArrival(tokenId, serial, env.TREASURY_ID));
      let state = listing.listed ? `listed, ${listing.price} ${CURRENCY}` : "not listed";
      if (achala) state = `in Achala ${achala.event.stone_id}${listing.listed ? ` (still ${state}: unlist it)` : ""}`;
      rows.push({ token: TOKEN_CLASSES[tokenClass].name, serial, stone_id: stoneId, state });
    }
  }
  if (!rows.length) {
    console.log(`The Treasury ${env.TREASURY_ID} holds no items.`);
    return;
  }
  console.table(rows);
  const listed = rows.filter((r) => r.state.startsWith("listed")).length;
  console.log(`${listed} of ${rows.length} items held by the Treasury ${env.TREASURY_ID} are listed.`);
}

runScript("Display event failed", async (session) => {
  // --- 1. Check the arguments and the environment ---
  const problems = [...input.problems];
  if (!problems.length) problems.push(...displayEnvProblems(process.env, input.command));
  if (problems.length) return fail(problems);

  // --- 2. Read both topics ---
  const provenance = await readProvenance(process.env);
  if (provenance.problem) return fail([provenance.problem]);
  const display = await readDisplay(process.env);
  if (display.problem) return fail([display.problem]);

  if (input.command === "status") {
    await showStatus(process.env, provenance.events, display.events);
    return;
  }

  // --- 3. Check the item, then build the event ---
  const prepared = await prepareEvent(process.env, provenance.events, display.events);
  if (prepared.problems) return fail(prepared.problems);
  const was = prepared.listing.listed ? `listed at ${prepared.listing.price} ${CURRENCY}` : "not listed";
  console.log(`✅ ${prepared.event.stone_id} is held by the Treasury, ${was}. ${prepared.event.event} event:`);
  console.log(JSON.stringify(prepared.event, null, 2));

  if (input.dryRun) {
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 4. Record it on the display topic (UA pays; signed with the submit key when set) ---
  const client = session.connect();
  const hcsTxId = await submitEvent(
    client,
    process.env.HCS_DISPLAY_TOPIC_ID,
    prepared.event,
    loadSubmitKey(process.env),
  );
  console.table({
    event: prepared.event.event,
    stone_id: prepared.event.stone_id,
    nft: `${prepared.event.token_id}/${input.serial}`,
    ...(prepared.event.price && { price: `${prepared.event.price} ${CURRENCY}` }),
    hcs_tx_id: hcsTxId,
  });
}, { usage: USAGE });
