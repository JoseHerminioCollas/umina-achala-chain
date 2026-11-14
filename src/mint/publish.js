/**
 * @file mint/publish.js
 * @description Step 4 of mintNFT.js (umina-achala-chain#34): pin the image
 * versions and documents to IPFS through Pinata, then the metadata JSON that
 * points to them, then mint one NFT whose metadata is that JSON's ipfs:// URI.
 */

import path from "path";
import { TokenMintTransaction } from "@hashgraph/sdk";
import { buildMetadata, pinFile, pinJson } from "./lib.js";

/**
 * Pins the files and the metadata, then mints (the supply key signs). The
 * same file listed twice is pinned once. When anything fails, the error
 * thrown carries `pinnedCids`, the CIDs pinned so far: no NFT points to them,
 * so they can be unpinned in Pinata.
 * @param {import("@hashgraph/sdk").Client} client
 * @param {{ stoneId: string, metadata: object, images: object[], documents: object[], assets: object[],
 *   tokenId: string, supplyKey: import("@hashgraph/sdk").PrivateKey, jwt: string }} mint
 *   metadata already has its attributes; assets are the files to pin
 * @returns {Promise<{ cid: string, ipfsUri: string, serials: string[], mintTxId: string }>}
 */
export async function pinAndMint(client, { stoneId, metadata, images, documents, assets, tokenId, supplyKey, jwt }) {
  const pinnedCids = [];
  try {
    const cidsByFile = new Map();
    for (const item of assets) {
      if (cidsByFile.has(item.file)) continue;
      const name = `${stoneId}-${path.basename(item.file)}`;
      const fileCid = await pinFile(item.file, name, item.mime, jwt);
      cidsByFile.set(item.file, fileCid);
      pinnedCids.push(fileCid);
      console.log(`✅ Pinned ${path.basename(item.file)}: ipfs://${fileCid}`);
    }
    const cid = await pinJson(buildMetadata(metadata, images, cidsByFile, documents), stoneId, jwt);
    pinnedCids.push(cid);
    const ipfsUri = `ipfs://${cid}`;
    console.log(`✅ Metadata pinned to IPFS: ${ipfsUri}`);

    const mintTx = await new TokenMintTransaction()
      .setTokenId(tokenId)
      .setMetadata([Buffer.from(ipfsUri)])
      .freezeWith(client)
      .sign(supplyKey);
    const mintResponse = await mintTx.execute(client);
    const mintReceipt = await mintResponse.getReceipt(client);
    return {
      cid,
      ipfsUri,
      serials: mintReceipt.serials.map(String),
      mintTxId: mintResponse.transactionId.toString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw Object.assign(error, { pinnedCids });
  }
}
