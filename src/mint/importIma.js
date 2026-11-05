/**
 * @file importIma.js
 * @description Imports the IMA-approved mineral species into
 * schema/stone-types.json from an RRUFF IMA Mineral List export
 * (umina-achala-chain#14). Curated entries are kept as they are; imported
 * species get an English name only and no HS code. Re-run it with a newer
 * export to update the list; species that disappear are marked deprecated,
 * never deleted.
 *
 * Get the export: https://rruff.net/ima-mineral-list/ with "IMA Approved
 * Minerals Only" ticked, exported as CSV (one column, mineral_name). Keep it
 * in schema/sources/ so the import can be checked and re-run.
 *
 * Run from the command line:
 * node src/mint/importIma.js <export.csv> [--dry-run]
 *
 * After running it, copy schema/stone-types.json to umina-achala-web too.
 */

import fs from "fs";
import path from "path";
import { mergeImaSpecies } from "./stoneTypes.js";

const LIST_FILE = "schema/stone-types.json";

/** Reads the mineral names from a one-column RRUFF export. */
export function readImaExport(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const unquote = (s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/""/g, '"');
  if (unquote(lines[0] ?? "") !== "mineral_name") {
    throw new Error('expected a one-column RRUFF export with the header "mineral_name"');
  }
  return lines.slice(1).map(unquote);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || !fs.existsSync(file)) {
    console.error("❌ Give the RRUFF export: node src/mint/importIma.js <export.csv> [--dry-run]");
    process.exitCode = 1;
    return;
  }
  try {
    const names = readImaExport(fs.readFileSync(file, "utf8"));
    const list = JSON.parse(fs.readFileSync(LIST_FILE, "utf8"));
    const { list: merged, added, curatedKept, deprecated } = mergeImaSpecies(list, names, {
      source: "RRUFF IMA Mineral List (rruff.net), IMA approved minerals only",
      file: path.basename(file),
      species: names.length,
    });
    console.log(`IMA species in the export: ${names.length}`);
    console.log(`New entries: ${added}`);
    console.log(`Already curated, kept as they are: ${curatedKept.length} (${curatedKept.join(", ")})`);
    if (deprecated.length) console.log(`No longer in the export, marked deprecated: ${deprecated.join(", ")}`);
    console.log(`Entries in the list: ${merged.types.length}`);
    if (dryRun) {
      console.log("Dry run, list not written.");
      return;
    }
    // One entry per line keeps diffs readable when the list is re-imported
    const body = merged.types.map((t) => `    ${JSON.stringify(t)}`).join(",\n");
    const { types, ...head } = merged;
    const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, "");
    fs.writeFileSync(LIST_FILE, `${headJson},\n  "types": [\n${body}\n  ]\n}\n`);
    console.log(`✅ ${LIST_FILE} written. Copy it to umina-achala-web/schema/ too.`);
  } catch (err) {
    console.error("❌ Import failed:", err.message);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("importIma.js")) main();
