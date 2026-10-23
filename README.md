# umina-achala-chain

Hedera scripts for Umiña Achala: create the HTS token, validate HIP-412 metadata, and mint NFTs (IPFS pin + HCS provenance message).

- `src/createUminaToken.js` creates the HTS token.
- `src/validateMetadata.js` validates a metadata file: `npm run validate`.
- `src/mintUminaNFT.js` validates, pins to IPFS, mints, and submits to HCS.
- `schema/hip412-umina-schema.json` is a copy of the schema in `umina-achala-web`.
- `json/example.json` is the metadata template.

Copy `.env.example` to `.env.testnet` and fill it in. Never commit `.env*` files. See `umina-achala-documents` for the guides.

Tests: `npm install && npm test`.
