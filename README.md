# umina-achala-chain

Hedera scripts for Umiña Achala: create the HTS token, validate HIP-412 metadata, and mint NFTs (IPFS pin + HCS provenance message).

## Layout

`src/` has one folder per step, and code shared by every step sits directly in `src/`. In each folder, the files named after an action are scripts you run (from the repo root, e.g. `node src/token/createUminaToken.js`); `lib.js` holds that step's checks and transaction building, kept apart so they can be tested without a network.

| Folder | Scripts | Helpers |
|---|---|---|
| `src/token/` | `createUminaToken.js` | `lib.js` |
| `src/mint/` | `mintUminaNFT.js`, `validateMetadata.js` | `lib.js`, `formPost.js`, `metadataValidator.js` |
| `src/consignment/` | `associateToken.js`, `consignToMerchant.js`, `sellConsigned.js` | `lib.js` |
| `src/` | | `keys.js` (ECDSA key parsing used by every script), `hcs.js` (builds HCS events with the envelope from umina-achala-chain#10, signs them with the optional `HCS_SUBMIT_KEY`, and waits for the receipt) |

## Scripts

- `src/token/createUminaToken.js` creates the HTS token on testnet: `node src/token/createUminaToken.js [env-file] [--dry-run]`. The env file defaults to `.env.testnet`. `--dry-run` checks it and prints the token parameters (no keys, no network). The token gets a 5% royalty to the treasury with a fallback fee of `FALLBACK_FEE_HBAR` HBAR (about USD 3, converted on the day of creation), and no metadata key, so NFT metadata is immutable. It prints the new token ID; save it as `UMINA_TOKEN_ID`.
- `src/token/lib.js` holds its env checks and the token transaction.
- `src/mint/validateMetadata.js` validates a metadata file: `npm run validate`.
- `src/mint/mintUminaNFT.js` validates the metadata, pins the item's images and then the metadata to IPFS through Pinata, mints, then submits the MINT message to HCS: `node src/mint/mintUminaNFT.js <metadata-file> [--dry-run]` or `--form <post-file>` (one of the two is required). The metadata file lists the item's pictures in an input-only `images` array (each with a `file` path relative to the metadata file, and a `description`); `image` and `files` are set from the pinned CIDs. Test images and documents go in `samples/` (git-ignored). To simulate the whole mint form flow, run `node src/mint/mintUminaNFT.js --form json/sample-form-post.json`: the post (text fields, `attributes`, `images`, `documents`) is turned into a metadata file in `generated/` (git-ignored, `--out` changes it) and minted. Optional `documents` (pdf, glb) are pinned after the images. The `properties.stone_id` must look like `UMINA-2026-CH-03`. It needs `PINATA_JWT`, `UMINA_TOKEN_ID`, `HCS_TOPIC_ID` and `SUPPLY_KEY` in `.env.testnet`.
- `src/mint/lib.js` holds its env checks and the Pinata pin; `src/mint/formPost.js` turns a form post into a metadata file, and `src/mint/metadataValidator.js` checks metadata against the schema.
- `src/consignment/consignToMerchant.js` consigns a minted serial (see `umina-achala-documents/consignment.md`): the merchant associates the token, the treasury transfers the serial to them, and they grant UA (the operator) an NFT allowance: `node src/consignment/consignToMerchant.js <serial> [--dry-run]`.
- `src/consignment/sellConsigned.js` sells a consigned serial in one atomic transfer: the buyer pays in HBAR, 70% goes to the merchant and 30% to UA, UA moves the NFT with the allowance, then the SALE message goes to HCS: `node src/consignment/sellConsigned.js <serial> <price-hbar> [--dry-run]`. The buyer must have associated the token first.
- `src/consignment/associateToken.js` associates the Umiña token with the merchant or buyer test account, which must happen before it can receive an NFT: `node src/consignment/associateToken.js <merchant|buyer> [--dry-run]`. The consignment scripts are testnet only and need `MERCHANT_ID`, `MERCHANT_KEY`, `BUYER_ID` and `BUYER_KEY` (test accounts standing in for a merchant and a buyer).
- `src/consignment/lib.js` holds the 70/30 split, the token association and their env checks.
- `schema/hip412-umina-schema.json` is a copy of the schema in `umina-achala-web`.
- `json/template.json` is the empty metadata template: fixed fields keep their values and everything else is `null`. The form post is copied into it and unfilled fields are removed. `json/example.json` is one filled-in record, kept for reference (no `image` or `files`; they are set at mint time). `json/sample-form-post.json` is a simulated form post.

Copy `.env.example` to `.env.testnet` and fill it in. Never commit `.env*` files. See `umina-achala-documents` for the guides.

Tests: `npm install && npm test`.
