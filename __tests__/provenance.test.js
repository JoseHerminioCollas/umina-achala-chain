import { jest } from "@jest/globals";
import { mountedStoneProblem, mountIds, readDisplay, readProvenance } from "../src/provenance.js";

describe("provenance helpers (umina-achala-chain#29)", () => {
  const env = { HCS_TOPIC_ID: "0.0.3003", UMINA_TOKEN_ID: "0.0.2002", ACHALA_TOKEN_ID: "0.0.2003" };

  test("readProvenance returns the events of HCS_TOPIC_ID", async () => {
    const read = jest.fn(async () => [{ event: "MINT" }]);
    expect(await readProvenance(env, read)).toEqual({ events: [{ event: "MINT" }] });
    expect(read).toHaveBeenCalledWith("0.0.3003");
  });

  test("readProvenance turns a read error into one problem", async () => {
    const read = async () => {
      throw new Error("HCS topic 0.0.3003 was not found on the mirror node");
    };
    expect(await readProvenance(env, read)).toEqual({
      problem: "cannot read HCS_TOPIC_ID 0.0.3003: HCS topic 0.0.3003 was not found on the mirror node",
    });
  });

  test("readDisplay reads HCS_DISPLAY_TOPIC_ID the same way (#43)", async () => {
    const read = jest.fn(async () => [{ event: "LISTED" }]);
    expect(await readDisplay({ HCS_DISPLAY_TOPIC_ID: "0.0.3004" }, read)).toEqual({ events: [{ event: "LISTED" }] });
    expect(read).toHaveBeenCalledWith("0.0.3004");
    const failing = async () => {
      throw new Error("not found");
    };
    expect(await readDisplay({ HCS_DISPLAY_TOPIC_ID: "0.0.3004" }, failing)).toEqual({
      problem: "cannot read HCS_DISPLAY_TOPIC_ID 0.0.3004: not found",
    });
  });

  test("mountIds takes the token IDs from the environment", () => {
    expect(mountIds(env, "7")).toEqual({ uminaTokenId: "0.0.2002", achalaTokenId: "0.0.2003", serial: "7" });
  });

  const mint = (seq, tokenId, stoneId, serials, extra = {}) => ({
    sequence_number: seq,
    event: { event: "MINT", token_id: tokenId, stone_id: stoneId, serials, ...extra },
  });

  test("mountedStoneProblem names the Achala a stone is mounted in, and is null otherwise", () => {
    const events = [
      mint(1, "0.0.2002", "UMINA-2026-CH-01", ["1"]),
      mint(2, "0.0.2002", "UMINA-2026-CH-02", ["2"]),
      mint(3, "0.0.2003", "ACHALA-2026-RG-01", ["1"], { from_stone_ids: ["UMINA-2026-CH-01"] }),
    ];
    expect(mountedStoneProblem(events, env, "1")).toContain("is mounted in Achala ACHALA-2026-RG-01");
    expect(mountedStoneProblem(events, env, "2")).toBeNull();
    expect(mountedStoneProblem(events, { ...env, ACHALA_TOKEN_ID: undefined }, "1")).toBeNull();
  });
});
