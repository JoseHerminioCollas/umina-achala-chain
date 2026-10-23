/**
 * @file createUminaToken.js
 * @description Creates the Umiña NFT Class on Hedera,
 * defining it as a non-fungible token with custom royalty fees and role keys.
 * testnet and mainnet configurations are included.
 * Use .env.testnet or .env.mainnet to set environment variables for the respective network.
 * Comment or uncomment the mainnet or testnet section as needed.
 */

import {
  Client,
  CustomRoyaltyFee,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  PrivateKey,
} from "@hashgraph/sdk";
import "dotenv/config";
// For Testnet
dotenv.config({ path: ".env.testnet" });
// For Mainnet
// dotenv.config({ path: ".env.mainnet" });

async function main() {
  console.log("🚀 Creating Umiña NFT Class...");

  // --- 1. Initialize Client ---
  // For Testnet
  const operatorId = process.env.OPERATOR_ID;
  const client = Client.forTestnet().setOperator(
    operatorId,
    PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY),
  );
  // For Mainnet
  // const client = Client.forMainnet().setOperator(
  //   operatorId,
  //   PrivateKey.fromStringECDSA(process.env.OPERATOR_KEY)
  // );
  console.log(`Network: ${client.networkName}, Operator: ${operatorId}`);

  // --- 2. Load Role Keys ---
  const treasuryAccountId = process.env.TREASURY_ID;
  const adminKey = PrivateKey.fromStringECDSA(process.env.ADMIN_KEY);
  const supplyKey = PrivateKey.fromStringECDSA(process.env.SUPPLY_KEY);
  const feeScheduleKey = PrivateKey.fromStringECDSA(
    process.env.FEE_SCHEDULE_KEY,
  );
  const pauseKey = PrivateKey.fromStringECDSA(process.env.PAUSE_KEY);
  const wipeKey = PrivateKey.fromStringECDSA(process.env.WIPE_KEY);

  // --- 3. Define Token Parameters ---
  const transaction = new TokenCreateTransaction()
    .setTokenName("Umiña")
    .setTokenSymbol("UMINA")
    .setTokenType(TokenType.NonFungibleUnique)
    // Roles
    .setTreasuryAccountId(treasuryAccountId)
    .setAdminKey(adminKey)
    .setSupplyKey(supplyKey)
    .setFeeScheduleKey(feeScheduleKey)
    .setPauseKey(pauseKey)
    .setWipeKey(wipeKey)

    // Royalty Policy
    .setCustomFees([
      new CustomRoyaltyFee()
        .setNumerator(5)
        .setDenominator(100)
        .setFeeCollectorAccountId(treasuryAccountId),
    ])

    // Supply & divisibility
    .setSupplyType(TokenSupplyType.Infinite)
    .setInitialSupply(0)
    .setDecimals(0)

    // Provenance memo
    .setTokenMemo("Umiña Achala: Authentic Peruvian Stones and Minerals")
    .freezeWith(client);

  // --- 4. Sign & Execute ---
  try {
    const signTx = await transaction.sign(adminKey);
    const response = await signTx.execute(client);
    const receipt = await response.getReceipt(client);
    console.log("-----------------------------------");
    console.log(`✅ Success! Umiña Token ID: ${receipt.tokenId}`);
    console.log("-----------------------------------");
    console.log("SAVE THIS ID IN YOUR .env FILE AS: UMINA_TOKEN_ID");
  } catch (err) {
    console.error("❌ Token creation failed:", err, { operatorId, treasuryAccountId });
  }

  client.close();
}

main().catch(console.error);
