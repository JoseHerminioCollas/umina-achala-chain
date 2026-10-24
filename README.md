# umina-achala-chain

Hedera scripts for Umiña Achala: create the HTS token, validate HIP-412 metadata, and mint NFTs (IPFS pin + HCS provenance message).

- `src/createUminaToken.js` creates the HTS token on testnet: `node src/createUminaToken.js [env-file] [--dry-run]`. The env file defaults to `.env.testnet`. `--dry-run` checks it and prints the token parameters (no keys, no network). It prints the new token ID; save it as `UMINA_TOKEN_ID`.
- `src/uminaToken.js` holds its env checks and the token transaction.
- `src/validateMetadata.js` validates a metadata file: `npm run validate`.
- `src/mintUminaNFT.js` validates the metadata, pins the item's images and then the metadata to IPFS through Pinata, mints, then submits the MINT message to HCS: `node src/mintUminaNFT.js <metadata-file> [--dry-run]` or `--form <post-file>` (one of the two is required). The metadata file lists the item's pictures in an input-only `images` array (each with a `file` path relative to the metadata file, and a `description`); `image` and `files` are set from the pinned CIDs. Test images and documents go in `samples/` (git-ignored). To simulate the whole mint form flow, run `node src/mintUminaNFT.js --form json/sample-form-post.json`: the post (text fields, `attributes`, `images`, `documents`) is turned into a metadata file in `generated/` (git-ignored, `--out` changes it) and minted. Optional `documents` (pdf, glb) are pinned after the images. The `properties.stone_id` must look like `UMINA-2026-CH-03`. It needs `PINATA_JWT`, `UMINA_TOKEN_ID`, `HCS_TOPIC_ID` and `SUPPLY_KEY` in `.env.testnet`.
- `src/mintUmina.js` holds its env checks and the Pinata pin.
- `schema/hip412-umina-schema.json` is a copy of the schema in `umina-achala-web`.
- `json/template.json` is the empty metadata template: fixed fields keep their values and everything else is `null`. The form post is copied into it and unfilled fields are removed. `json/example.json` is one filled-in record, kept for reference (no `image` or `files`; they are set at mint time). `json/sample-form-post.json` is a simulated form post.

Copy `.env.example` to `.env.testnet` and fill it in. Never commit `.env*` files. See `umina-achala-documents` for the guides.

Tests: `npm install && npm test`.
