/**
 * @file testHelpers/mockMirror.js
 * @description A fake testnet mirror node for script tests: replaces
 * global.fetch so topicEvents reads the given events, and nftInfo the given
 * NFTs. Kept outside __tests__ so Jest does not run it as a test.
 */
import { jest } from "@jest/globals";

const realFetch = global.fetch;

/**
 * Serves `events` as the messages of any topic (one page, base64 as the
 * mirror node does) and `nfts["<token>/<serial>"]` as NFT info (null: not
 * found). Returns the list of URLs requested.
 * @param {object[]} [events] event objects, oldest first
 * @param {{ nfts?: Record<string, object | null>, topicMissing?: boolean }} [options]
 * @returns {string[]}
 */
export function mockMirror(events = [], { nfts = {}, topicMissing = false } = {}) {
  const urls = [];
  const json = (status, body) => ({
    ok: status === 200,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  global.fetch = jest.fn(async (url) => {
    urls.push(url);
    const nft = /\/api\/v1\/tokens\/([\d.]+)\/nfts\/(\d+)$/.exec(url);
    if (nft) {
      const info = nfts[`${nft[1]}/${nft[2]}`];
      return info === null || info === undefined ? json(404, {}) : json(200, info);
    }
    if (/\/api\/v1\/topics\/[\d.]+$/.test(url)) {
      return topicMissing ? json(404, {}) : json(200, { deleted: false });
    }
    if (/\/api\/v1\/topics\/[\d.]+\/messages/.test(url)) {
      return json(200, {
        messages: events.map((event, i) => ({
          sequence_number: i + 1,
          message: Buffer.from(JSON.stringify(event)).toString("base64"),
        })),
        links: { next: null },
      });
    }
    return json(404, {});
  });
  return urls;
}

/** Puts the real fetch back. */
export function restoreMirror() {
  global.fetch = realFetch;
}
