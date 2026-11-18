/**
 * @file testnet/transferBetweenWallets.js
 * @description Testnet only (umina-achala-chain#40): a wallet-to-wallet
 * transfer of an Umiña or an Achala between the test merchant and the test
 * buyer, signed by both. It stands in for a sale made elsewhere in the
 * testnet run (#22, section 4).
 *
 * Why both sign: the token's royalty has a fallback fee, charged to the
 * receiver when no HBAR moves, so the receiver must sign. A wallet's plain
 * Send signs with the sender only and fails with INVALID_SIGNATURE.
 *
 * On mainnet UA never holds the merchant's or the buyer's keys; a real sale
 * made elsewhere is signed in their own wallets. So the tool refuses any
 * NETWORK but testnet, before the env file is read, and it lives apart from
 * the scripts that act as UA.
 *
 * NETWORK=testnet node src/testnet/transferBetweenWallets.js <serial>[,<serial>...]
 *   --from merchant|buyer [--to merchant|buyer] [--token umina|achala]
 *   [--hbar <amount>] [--dry-run]
 *
 * - No --hbar: no HBAR moves, so the receiver pays the fallback fee to the
 *   Treasury.
 * - --hbar <amount>: the receiver pays that to the sender in the same
 *   transaction, and the royalty applies to it (5%, from the sender).
 * - --token achala: the Achala moves with every Umiña mounted in it (from its
 *   MINT), as in the sale scripts. An Umiña mounted in an Achala is refused.
 *
 * The sender pays the network fee. The topic and the holders (mirror node)
 * are read first, also on --dry-run. After the transfer it prints the custom
 * fees assessed and the recordEvent.js command that records it as a SALE.
 */

import { AccountId, Client, Hbar, NftId, TokenId, TransferTransaction } from "@hashgraph/sdk";
import { parseTransferArgs, recordCommand, testnetOnlyProblem, transferProblems } from "./lib.js";
import { holderProblems, readHolders } from "../nfts.js";
import { parseEcdsaKey } from "../keys.js";
import { mountIds, readProvenance } from "../provenance.js";
import { achalaSalePlan, mountedProblem } from "../mint/achala.js";
import { fail, loadEnv, runScript } from "../script.js";

const input = parseTransferArgs(process.argv.slice(2));
const testnetProblem = testnetOnlyProblem(process.env);
if (!testnetProblem) loadEnv();

const USAGE = `Testnet only: move an NFT between the test merchant and the test buyer,
signed by both (a sale made elsewhere). Prints the custom fees assessed and
the recordEvent.js command to record it.

Usage: NETWORK=testnet node src/testnet/transferBetweenWallets.js <serial>[,<serial>...]
         --from merchant|buyer [--to merchant|buyer] [--token umina|achala]
         [--hbar <amount>] [--dry-run]

  <serial>               the NFT serial; several Umiña serials move together
  --from, --to           the wallets (MERCHANT_ID/KEY, BUYER_ID/KEY); --to
                         defaults to the other one
  --token umina|achala   the token class (default umina); an Achala moves
                         with its stones
  --hbar <amount>        the receiver pays this to the sender in the same
                         transaction; without it the receiver pays the
                         fallback fee`;

const tinybarsText = (t) => `${Hbar.fromTinybars(t.toString()).toString()}`;

runScript("Transfer failed", async () => {
  if (testnetProblem) return fail([testnetProblem]);
  const problems = [...input.problems];
  if (!problems.length) problems.push(...transferProblems(process.env, input));
  if (problems.length) return fail(problems);

  const { serials, tokenClass, tinybars } = input;
  const isAchala = tokenClass === "achala";
  const wallet = (role) => ({
    role,
    id: AccountId.fromString(process.env[`${role.toUpperCase()}_ID`]),
    key: parseEcdsaKey(process.env[`${role.toUpperCase()}_KEY`]),
  });
  const from = wallet(input.from);
  const to = wallet(input.to);

  // --- 1. The NFTs that move: an Achala with its stones; no mounted stone alone ---
  const { events, problem } = await readProvenance(process.env);
  if (problem) return fail([problem]);
  const uminaTokenId = TokenId.fromString(process.env.UMINA_TOKEN_ID);
  let nftIds;
  let piece;
  if (isAchala) {
    const plan = achalaSalePlan(events, mountIds(process.env, serials[0]));
    if (plan.problems.length) return fail(plan.problems);
    piece = plan;
    nftIds = [
      new NftId(TokenId.fromString(process.env.ACHALA_TOKEN_ID), Number(serials[0])),
      ...plan.stones.map((s) => new NftId(uminaTokenId, Number(s.serial))),
    ];
  } else {
    const mounted = serials.map((s) => mountedProblem(events, mountIds(process.env, s))).filter(Boolean);
    if (mounted.length) return fail(mounted);
    nftIds = serials.map((s) => new NftId(uminaTokenId, Number(s)));
  }

  // --- 2. The sender holds every NFT (mirror node) ---
  const held = holderProblems(nftIds, await readHolders(nftIds), from.id.toString(), {
    holder: `the ${from.role}`,
    then: "Check the serial and --from.",
  });
  if (held.length) return fail(held);

  console.table({
    nfts: nftIds.join(", "),
    ...(piece && { piece: piece.achalaId, stones: piece.stones.map((s) => s.stone_id).join(", ") }),
    from: `${from.role} ${from.id}`,
    to: `${to.role} ${to.id}`,
    hbar: tinybars ? `${tinybarsText(tinybars)} from the ${to.role} to the ${from.role}` : "none (paid elsewhere)",
    fee_payer: `${from.role} ${from.id}`,
    signers: `${from.role}, ${to.role}`,
  });
  console.log(
    tinybars
      ? `Expected: 5% royalty on the payment, from the ${from.role}, once per token among the NFTs.`
      : `Expected: the fallback fee, paid by the ${to.role} to the Treasury, once per token among the NFTs.`,
  );
  if (input.dryRun) {
    console.log("Dry run, nothing sent.");
    return;
  }

  // --- 3. One transfer, the sender as operator (pays the fee), both signing ---
  const client = Client.forTestnet().setOperator(from.id, from.key);
  try {
    let tx = new TransferTransaction().setTransactionMemo(
      tinybars ? "UA testnet: paid wallet transfer" : "UA testnet: sale made elsewhere",
    );
    for (const id of nftIds) tx = tx.addNftTransfer(id, from.id, to.id);
    if (tinybars) {
      tx = tx
        .addHbarTransfer(to.id, Hbar.fromTinybars((-tinybars).toString()))
        .addHbarTransfer(from.id, Hbar.fromTinybars(tinybars.toString()));
    }
    tx = await tx.freezeWith(client).sign(to.key);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const txId = response.transactionId.toString();
    console.log(`✅ ${nftIds.join(", ")} transferred to the ${to.role} ${to.id}: ${receipt.status} (${txId})`);

    // --- 4. What the royalty did, and how to record the sale ---
    const record = await response.getRecord(client);
    if (!record.assessedCustomFees.length) console.log("   No custom fee assessed.");
    for (const fee of record.assessedCustomFees) {
      const what = fee.tokenId ? `${fee.amount} of token ${fee.tokenId}` : tinybarsText(fee.amount);
      console.log(`   Custom fee: ${what} to ${fee.feeCollectorAccountId}, paid by ${fee.payerAccountIds.join(", ")}`);
    }
    if (serials.length > 1) {
      console.log("Several stones moved in one transaction: recordEvent.js records one NFT per SALE, so this one is not recorded.");
    } else {
      console.log("Record it as a SALE (check the price and payment first):");
      const hbar = tinybars ? input.hbar : null;
      console.log(`   ${recordCommand({ serial: serials[0], tokenClass, sellerId: from.id, buyerId: to.id, txId, hbar })}`);
    }
  } finally {
    client.close();
  }
}, { usage: USAGE });
