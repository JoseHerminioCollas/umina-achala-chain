import fs from "fs";
import { validateMetadata } from "../src/metadataValidator.js";

// --- Mock Hedera SDK ---
jest.mock("@hashgraph/sdk", () => ({
  Client: {
    forTestnet: () => ({ setOperator: jest.fn().mockReturnThis() }),
    forMainnet: () => ({ setOperator: jest.fn().mockReturnThis() })
  },
  PrivateKey: { fromStringECDSA: jest.fn(() => "mock-key") },
  TokenMintTransaction: jest.fn().mockImplementation(() => ({
    setTokenId: jest.fn().mockReturnThis(),
    setMetadata: jest.fn().mockReturnThis(),
    setMaxTransactionFee: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({
      getReceipt: jest.fn().mockResolvedValue({ serials: [123] })
    })
  }))
}));

jest.mock("ipfs-http-client"); // Jest will auto‑load __mocks__/ipfs-http-client.js

describe("mintUminaNFT.js workflow", () => {
  test("validates metadata JSON against schema", () => {
    const metadata = JSON.parse(fs.readFileSync("./json/example.json", "utf8"));
    const { valid, errors } = validateMetadata(metadata);
    expect(valid).toBe(true);
    expect(errors).toBeNull();
  });

  test("mints NFT with mocked Hedera + IPFS", async () => {
    const { Client, PrivateKey, TokenMintTransaction } = await import("@hashgraph/sdk");
    const { create } = await import("ipfs-http-client");

    const client = Client.forTestnet().setOperator("mock-id", PrivateKey.fromStringECDSA("mock-key"));
    const ipfs = create();
    const { cid } = await ipfs.add(JSON.stringify({ foo: "bar" }));
    const ipfsUri = `ipfs://${cid.toString()}`;

    const mintTx = new TokenMintTransaction()
      .setTokenId("0.0.mockToken")
      .setMetadata([Buffer.from(ipfsUri)]);

    const response = await mintTx.execute(client);
    const receipt = await response.getReceipt(client);

    expect(receipt.serials).toEqual([123]);
    expect(ipfsUri).toMatch(/^ipfs:\/\/QmMockCID12345$/);
  });
});
