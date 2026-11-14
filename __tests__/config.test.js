import ua from "../config/umina-achala.js";
import umina from "../config/umina.js";
import achala from "../config/achala.js";
import { TOKEN_CLASSES } from "../src/token/lib.js";
import { TOPICS } from "../src/topic/lib.js";
import { MINT_CLASSES } from "../src/mint/lib.js";
import { classOfMetadata } from "../src/mint/metadataValidator.js";

// The tokens and topics made for the testnet run (umina-achala-chain#22) carry
// these values. A change here only applies to tokens and topics created after
// it, so a failing test is a reminder, not a bug (#34).
describe("config (umina-achala-chain#34)", () => {
  test("the token classes keep the names, symbols and memos already on testnet", () => {
    expect(TOKEN_CLASSES).toEqual({ umina, achala });
    expect([umina.name, umina.symbol, umina.memo]).toEqual(["Umiña", "UMINA", "Umiña: Peruvian stones"]);
    expect([achala.name, achala.symbol, achala.memo]).toEqual([
      "Achala",
      "ACHALA",
      "Achala: Peruvian jewelry made of Umiña stones",
    ]);
    expect([umina.envVar, achala.envVar]).toEqual(["UMINA_TOKEN_ID", "ACHALA_TOKEN_ID"]);
  });

  test("the topics keep their memos and env variables", () => {
    expect(TOPICS).toEqual({
      provenance: { envVar: "HCS_TOPIC_ID", memo: "Umiña Achala provenance" },
      display: { envVar: "HCS_DISPLAY_TOPIC_ID", memo: "Umiña Achala display" },
    });
  });

  test("royalty 5% and UA's 30% commission", () => {
    expect(ua.royalty).toEqual({ numerator: 5, denominator: 100 });
    expect(ua.commissionBps).toBe(3000n);
  });

  test("each class's stone_id pattern comes from its prefix", () => {
    expect(MINT_CLASSES.umina.idPattern.test("UMINA-2026-CH-03")).toBe(true);
    expect(MINT_CLASSES.umina.idPattern.test("ACHALA-2026-RI-01")).toBe(false);
    expect(MINT_CLASSES.achala.idPattern.test("ACHALA-2026-RI-01")).toBe(true);
    expect(MINT_CLASSES.achala.idPattern.test("UMINA-2026-CH-03")).toBe(false);
    expect(classOfMetadata({ properties: { stone_id: "ACHALA-2026-RI-01" } })).toBe("achala");
    expect(classOfMetadata({ properties: { stone_id: "UMINA-2026-CH-03" } })).toBe("umina");
    expect(classOfMetadata({})).toBe("umina");
  });
});
