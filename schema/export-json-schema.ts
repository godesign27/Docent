// Writes schema/contract.schema.json so non-TypeScript consumers (calling
// agents, client engineering teams) can validate contracts too.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Contract } from "./contract.js";

const out = fileURLToPath(new URL("./contract.schema.json", import.meta.url));
writeFileSync(out, JSON.stringify(z.toJSONSchema(Contract), null, 2) + "\n");
console.log(`Wrote ${out}`);
