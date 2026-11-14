import { envFileProblem, mirrorNode, NETWORKS, networkName, networkProblem } from "../src/network.js";

describe("network (umina-achala-chain#29, #34)", () => {
  test("NETWORK has no default", () => {
    expect(networkName({})).toBeUndefined();
    expect(networkName({ NETWORK: "" })).toBeUndefined();
    expect(networkName({ NETWORK: "testnet" })).toBe("testnet");
    expect(networkName({ NETWORK: "mainnet" })).toBe("mainnet");
  });

  test("an unset NETWORK is refused, so a forgotten variable reaches no network", () => {
    const unset = "NETWORK is not set: put NETWORK=testnet or NETWORK=mainnet in front of the command";
    expect(networkProblem({})).toBe(unset);
    expect(networkProblem({ NETWORK: "" })).toBe(unset);
  });

  test("testnet is usable; mainnet is listed but not enabled; anything else is refused", () => {
    expect(networkProblem({ NETWORK: "testnet" })).toBeNull();
    expect(networkProblem({ NETWORK: "mainnet" })).toBe(
      "NETWORK=mainnet is not enabled yet: its keys and accounts are not decided (umina-achala-chain#32)",
    );
    expect(networkProblem({ NETWORK: "previewnet" })).toBe(
      'NETWORK must be testnet or mainnet, got "previewnet"',
    );
    expect(networkProblem({ NETWORK: "constructor" })).toBe(
      'NETWORK must be testnet or mainnet, got "constructor"',
    );
  });

  test("each network has its own env file and mirror node (config/testnet.js, config/mainnet.js)", () => {
    expect(NETWORKS.testnet.envFile).toBe(".env.testnet");
    expect(NETWORKS.mainnet.envFile).toBe(".env.mainnet");
    expect(mirrorNode({ NETWORK: "testnet" })).toBe("https://testnet.mirrornode.hedera.com");
    expect(mirrorNode({ NETWORK: "mainnet" })).toBe("https://mainnet.mirrornode.hedera.com");
  });

  test("the mirror node is not guessed when NETWORK names no network", () => {
    expect(() => mirrorNode({})).toThrow("NETWORK is not set");
    expect(() => mirrorNode({ NETWORK: "previewnet" })).toThrow('got "previewnet"');
  });

  test("an env file must name the network", () => {
    const testnet = { NETWORK: "testnet" };
    expect(envFileProblem(".env.testnet", testnet)).toBeNull();
    expect(envFileProblem("config/other.testnet.env", testnet)).toBeNull();
    expect(envFileProblem(".env.mainnet", testnet)).toBe(
      ".env.mainnet is not a testnet env file (NETWORK is testnet)",
    );
    expect(envFileProblem("testnet/.env.mainnet", testnet)).toBe(
      "testnet/.env.mainnet is not a testnet env file (NETWORK is testnet)",
    );
  });

  test("with NETWORK unset the env file is not judged: the NETWORK problem is reported instead", () => {
    expect(envFileProblem(".env.mainnet", {})).toBeNull();
  });
});
