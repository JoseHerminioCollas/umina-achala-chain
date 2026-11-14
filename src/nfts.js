/**
 * @file nfts.js
 * @description Who holds the NFTs a script is about to move, from the mirror
 * node (umina-achala-chain#28, #34). The sale and consignment scripts check
 * this before sending, so a listing that is out of date fails with a clear
 * message. Mirror node reads are free and are made all at once, where a
 * TokenNftInfoQuery per NFT was a paid query each.
 *
 * The mirror node can lag the ledger by a few seconds. If an NFT moved just
 * before, the network refuses the transfer itself, and since a transfer is
 * atomic nothing moves.
 */

import { nftInfo } from "./mirror.js";

/**
 * The mirror node info of each NFT, in the same order (null when unknown).
 * @param {import("@hashgraph/sdk").NftId[]} nftIds
 * @returns {Promise<Array<{ account_id?: string, deleted?: boolean } | null>>}
 */
export function readHolders(nftIds, fetchFn = fetch) {
  return Promise.all(nftIds.map((id) => nftInfo(id.tokenId.toString(), id.serial.toString(), fetchFn)));
}

/**
 * The problems with the NFTs a script moves: each must exist, not be burned,
 * and be held by `holderId`.
 * @param {Array<{ toString(): string }>} nftIds printed as token/serial
 * @param {Array<{ account_id?: string, deleted?: boolean } | null>} infos from readHolders
 * @param {string} holderId
 * @param {{ holder?: string, then?: string }} [words] who the holder is
 *   ("the Treasury", "the merchant") and what to do about it
 * @returns {string[]}
 */
export function holderProblems(nftIds, infos, holderId, { holder = "the Treasury", then = "Remove the listing." } = {}) {
  return nftIds.flatMap((id, i) => {
    const info = infos[i];
    if (!info) return [`${id} is not on the mirror node. Check the serial.`];
    if (info.deleted) return [`${id} is burned. ${then}`];
    if (info.account_id !== String(holderId)) {
      return [`${id} is held by ${info.account_id}, not ${holder} ${holderId}. ${then}`];
    }
    return [];
  });
}
