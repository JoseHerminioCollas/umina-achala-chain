/**
 * @file mintUminaNFT.js
 * @description Script to mint an Umiña NFT with compliance proof anchored in HCS and metadata pinned to IPFS.
 *
 * Run from the command line:
 * node mintUminaNFT.js
 *
 * ## Output
 * - IPFS CID of pinned metadata
 * - Minted NFT serial number(s)
 * - Provenance log (stone_id, event, actor_id, ipfs_cid, hcs_tx_id, timestamp)
 */

import dotenv from "dotenv";
import {
  Client,
  PrivateKey,
  TokenMintTransaction,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import fs from "fs";
import { create } from "ipfs-http-client";
import { validateMetadata } from "./metadataValidator.js";

// Load environment variables
// For Testnet
dotenv.config({ path: ".env.testnet" });
// For Mainnet
// dotenv.config({ path: ".env.mainnet" });

async function main() {
  try {
    // --- 1. Connect to Hedera ---
    const operatorId = process.env.OPERATOR_ID;

    // For Testnet
    const client = Client.forTestnet().setOperator(
      operatorId,
      PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY),
    );
    // For Mainnet
    // const client = Client.forMainnet().setOperator(
    //   operatorId,
    //   PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY),
    // );

    // --- 2. Prepare and validate HIP‑412 JSON metadata ---
    const metadata = JSON.parse(fs.readFileSync("json/example.json", "utf8"));
    metadata.timestamp = new Date().toISOString();
    // Generate stone_id dynamically: stone_type + date
    metadata.stone_id = `${metadata.stone_type}-${metadata.timestamp}`;
    // Validate metadata JSON against HIP-412 schema
    const { valid, errors } = validateMetadata(metadata);
    if (!valid) {
      throw new Error(`Metadata validation failed: ${JSON.stringify(errors)}`);
    }
    console.log("✅ Metadata validation passed.");

    // --- 3. Submit Minting message to HCS (Birth Certificate) ---
    const hcsTopicId = process.env.HCS_TOPIC_ID;
    const hcsResponse = await new TopicMessageSubmitTransaction()
      .setTopicId(hcsTopicId)
      .setMessage(
        JSON.stringify({
          event: "MINT",
          stone_id: metadata.stone_id,
          actor_id: operatorId,
        }),
      )
      .execute(client);

    const hcsTxId = hcsResponse.transactionId.toString();
    metadata.compliance_proof_hcs = hcsTxId;

    // --- 4. Pin metadata JSON to IPFS ---
    // Load from environment variables
    const projectId = process.env.INFURA_PROJECT_ID;
    const projectSecret = process.env.INFURA_PROJECT_SECRET;

    // Encode credentials for Basic Auth
    const auth =
      "Basic " +
      Buffer.from(projectId + ":" + projectSecret).toString("base64");

    // Create IPFS client with Infura endpoint + auth headers
    const ipfs = create({
      url: "https://ipfs.infura.io:5001",
      headers: {
        authorization: auth,
      },
    });
    const { cid } = await ipfs.add(JSON.stringify(metadata));
    const ipfsUri = `ipfs://${cid.toString()}`;
    console.log(`✅ Metadata pinned to IPFS: ${ipfsUri}`);

    // --- 5. Mint NFT under existing Umiña Token ID ---
    const uminaTokenId = process.env.UMINA_TOKEN_ID;
    const mintTx = new TokenMintTransaction()
      .setTokenId(uminaTokenId)
      .setMetadata([Buffer.from(ipfsUri)]);

    const mintResponse = await mintTx.execute(client);
    const mintReceipt = await mintResponse.getReceipt(client);
    console.log(`✅ Minted Umiña NFT serials: ${mintReceipt.serials}`);

    // --- 6. Provenance logging ---
    console.table({
      stone_id: metadata.stone_id,
      event: "MINT",
      actor_id: operatorId,
      ipfs_cid: cid.toString(),
      hcs_tx_id: hcsTxId,
      timestamp: metadata.timestamp,
    });
  } catch (err) {
    console.error("❌ Unexpected error during minting workflow:", err);
  }
}

main();
