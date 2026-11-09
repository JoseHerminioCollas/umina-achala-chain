import { jest } from "@jest/globals";
import { PrivateKey } from "@hashgraph/sdk";

// src/script.js with dotenv and the Hedera client mocked (umina-achala-chain#29)
const calls = {};

async function load() {
  jest.resetModules();
  calls.dotenv = jest.fn();
  calls.close = jest.fn();
  calls.setOperator = jest.fn();
  const client = { setOperator: calls.setOperator, close: calls.close };
  calls.setOperator.mockReturnValue(client);
  calls.forTestnet = jest.fn(() => client);
  calls.forMainnet = jest.fn(() => client);
  jest.doMock("dotenv", () => ({ __esModule: true, default: { config: calls.dotenv } }));
  jest.doMock("@hashgraph/sdk", () => {
    const actual = jest.requireActual("@hashgraph/sdk");
    return { ...actual, Client: { forTestnet: calls.forTestnet, forMainnet: calls.forMainnet } };
  });
  return import("../src/script.js");
}

describe("script startup (umina-achala-chain#29)", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.exitCode = undefined;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  test("loadEnv reads the network's env file, or the one given", async () => {
    delete process.env.NETWORK;
    const { loadEnv } = await load();
    expect(loadEnv()).toBe(".env.testnet");
    expect(calls.dotenv).toHaveBeenCalledWith({ path: ".env.testnet" });
    expect(loadEnv(".env.testnet.local")).toBe(".env.testnet.local");
  });

  test("loadEnv reads nothing for an unusable NETWORK or a file of another network", async () => {
    const { loadEnv } = await load();
    expect(loadEnv(".env.mainnet")).toBeUndefined();
    process.env.NETWORK = "mainnet";
    expect(loadEnv()).toBeUndefined();
    expect(calls.dotenv).not.toHaveBeenCalled();
  });

  test("fail prints the problems and sets the exit code", async () => {
    const { fail } = await load();
    fail(["A is not set", "B is wrong"], "Problems in .env.testnet");
    expect(console.error.mock.calls).toEqual([
      ["❌ Problems in .env.testnet:"],
      ["   - A is not set"],
      ["   - B is wrong"],
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("runScript connects to the network as the operator and closes the client", async () => {
    delete process.env.NETWORK;
    process.env.OPERATOR_ID = "0.0.1001";
    process.env.OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
    const { runScript } = await load();
    await runScript("Test failed", async (session) => {
      session.connect();
    });
    expect(calls.forTestnet).toHaveBeenCalled();
    expect(calls.setOperator).toHaveBeenCalledWith("0.0.1001", expect.anything());
    expect(calls.close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("runScript reports an error, runs afterError and still closes the client", async () => {
    process.env.OPERATOR_ID = "0.0.1001";
    process.env.OPERATOR_KEY = PrivateKey.generateECDSA().toStringDer();
    const { runScript } = await load();
    const afterError = jest.fn(() => console.error("   already moved"));
    await runScript(
      "Sale failed",
      async (session) => {
        session.connect();
        throw new Error("boom");
      },
      afterError,
    );
    expect(console.error).toHaveBeenCalledWith("❌ Sale failed:", expect.any(Error));
    expect(console.error).toHaveBeenCalledWith("   already moved");
    expect(calls.close).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("runScript refuses mainnet until it is enabled, before running anything", async () => {
    process.env.NETWORK = "mainnet";
    const { runScript } = await load();
    const body = jest.fn();
    await runScript("Test failed", body);
    expect(body).not.toHaveBeenCalled();
    expect(calls.forMainnet).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "   - NETWORK=mainnet is not enabled yet: its keys and accounts are not decided (umina-achala-chain#6)",
    );
    expect(process.exitCode).toBe(1);
  });
});
