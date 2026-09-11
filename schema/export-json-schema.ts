// Writes JSON Schemas for the contract and for Docent's responses, so
// non-TypeScript consumers (calling agents, client engineering teams) can validate them.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Contract } from "./contract.js";
import { AskInput, DocentResponse } from "./response.js";

for (const [name, schema] of [
  ["contract", Contract],
  ["ask-input", AskInput],
  ["response", DocentResponse],
] as const) {
  const out = fileURLToPath(new URL(`./${name}.schema.json`, import.meta.url));
  writeFileSync(out, JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n");
  console.log(`Wrote ${out}`);
}
