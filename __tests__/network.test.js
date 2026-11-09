import { envFileProblem, mirrorNode, NETWORKS, networkName, networkProblem } from "../src/network.js";

describe("network (umina-achala-chain#29)", () => {
  test("NETWORK defaults to testnet", () => {
    expect(networkName({})).toBe("testnet");
    expect(networkName({ NETWORK: "" })).toBe("testnet");
    expect(networkName({ NETWORK: "mainnet" })).toBe("mainnet");
  });

  test("testnet is usable; mainnet is listed but not enabled; anything else is refused", () => {
    expect(networkProblem({})).toBeNull();
    expect(networkProblem({ NETWORK: "mainnet" })).toBe(
      "NETWORK=mainnet is not enabled yet: its keys and accounts are not decided (umina-achala-chain#6)",
    );
    expect(networkProblem({ NETWORK: "previewnet" })).toBe(
      'NETWORK must be testnet or mainnet, got "previewnet"',
    );
  });

  test("each network has its own env file and mirror node", () => {
    expect(NETWORKS.testnet.envFile).toBe(".env.testnet");
    expect(mirrorNode({})).toBe("https://testnet.mirrornode.hedera.com");
    expect(mirrorNode({ NETWORK: "mainnet" })).toBe("https://mainnet.mirrornode.hedera.com");
  });

  test("an env file must name the network", () => {
    expect(envFileProblem(".env.testnet", {})).toBeNull();
    expect(envFileProblem("config/other.testnet.env", {})).toBeNull();
    expect(envFileProblem(".env.mainnet", {})).toBe(".env.mainnet is not a testnet env file (NETWORK is testnet)");
    expect(envFileProblem("testnet/.env.mainnet", {})).toBe(
      "testnet/.env.mainnet is not a testnet env file (NETWORK is testnet)",
    );
  });
});
