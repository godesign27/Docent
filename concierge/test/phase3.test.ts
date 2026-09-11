import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type LoadedConfig } from "../../config/load.js";
import { buildContract, type IngestResult } from "../../ingestion/ingest.js";
import { writeOutputs } from "../../ingestion/report.js";
import { resolveSource } from "../../ingestion/source.js";
import type { Contract } from "../../schema/contract.js";
import { Concierge, MemoryReviewStore, type AuditEntry, type CallerInfo } from "../concierge.js";
import { checkIsolation } from "../isolation.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../ingestion/test/fixtures/${name}`, import.meta.url));
const caller: CallerInfo = { name: "test", client: null, transport: "test" };

let acme: LoadedConfig;
let globex: LoadedConfig;
let acmeBuilt: IngestResult;
let globexBuilt: IngestResult;

const tokenById = (c: Contract, id: string) => c.tokens.find((t) => t.id === id);

function concierge(loaded: LoadedConfig, built: IngestResult) {
  const audit = { entries: [] as AuditEntry[], record(e: AuditEntry) { this.entries.push(e); } };
  return new Concierge({
    contract: built.contract,
    sources: built.sources,
    audit,
    policy: loaded.config.escalation,
    domains: loaded.config.specialists,
    reviews: new MemoryReviewStore(),
    docentVersion: "test",
  });
}

beforeAll(async () => {
  acme = loadConfig(fixture("acme.yaml"));
  globex = loadConfig(fixture("globex.yaml"));
  acmeBuilt = await buildContract(acme.config, resolveSource(acme.config));
  globexBuilt = await buildContract(globex.config, resolveSource(globex.config));
});

describe("a second, differently shaped client on the same code", () => {
  it("reads Tailwind v4 @theme variables as tokens with utility bindings", () => {
    const c = globexBuilt.contract;
    expect(tokenById(c, "color-brand-teal")?.tailwind.map((b) => [b.section, b.key])).toEqual([["colors", "brand-teal"]]);
    expect(tokenById(c, "text-body")?.tailwind.map((b) => [b.section, b.key])).toEqual([["fontSize", "body"]]);
    expect(tokenById(c, "text-body--line-height")?.tailwind).toEqual([]);
    // A plain @theme alias is a token; an @theme inline alias only wires a utility to the runtime variable.
    expect(tokenById(c, "color-brand-orange")).toMatchObject({ references: ["color-brand-orange-400"], type: "color" });
    expect(tokenById(c, "color-primary")).toBeUndefined();
    expect(tokenById(c, "primary")?.tailwind.map((b) => b.key)).toEqual(["primary"]);
    expect(tokenById(c, "surface")?.values).toMatchObject({ base: { raw: "var(--color-neutral-white)" }, dark: { raw: "#1c2021" } });
  });

  it("traces component styles through those bindings", () => {
    const button = globexBuilt.contract.components.find((x) => x.id === "button")!;
    expect(button.tokenRefs).toEqual(
      expect.arrayContaining(["primary", "surface", "color-brand-teal", "color-brand-orange-400", "color-neutral-white", "radius-button", "text-body"]),
    );
    expect(button.parts[0]!.variants.map((v) => v.name)).toEqual(["variant", "size"]);
    expect(button.importPath).toBe("@/components/ui/button");
  });

  it("finds undefined variables in the client's own token CSS", () => {
    const gap = globexBuilt.contract.gaps.find((g) => g.kind === "unresolved-token-reference" && g.subject.id === "spacing-sm");
    expect(gap?.message).toContain("spacing-4");
  });

  it("matches docs whose headings name the file", () => {
    const button = globexBuilt.contract.components.find((x) => x.id === "button")!;
    expect(button.docs.map((d) => d.heading)).toEqual(["`button.tsx`"]);
  });

  it("reads rules from a bullet list under a markdown heading", () => {
    expect(globexBuilt.contract.governance.rules.map((r) => [r.id, r.severity, r.rule])).toEqual([
      ["road-1", "high", "Never hardcode a value that exists as a token. Colors and radii come from tokens.json."],
      ["road-2", "high", "All spacing is a multiple of 4px."],
      ["road-3", "high", "Orange is reserved for actions and selected states."],
    ]);
    expect(globexBuilt.contract.governance.checks).toEqual({ "raw-color": "road-1", "palette-utility": "road-1" });
  });

  it("delivers a Tailwind v4 foundation with the packages its CSS imports", () => {
    expect(globexBuilt.contract.foundation).toMatchObject({ files: ["src/index.css", "src/styles/tokens.css"] });
    expect(globexBuilt.contract.foundation!.packages.map((p) => p.name)).toEqual(["@tailwindcss/vite", "tailwindcss"]);
  });
});

describe("per-client specialists and policy", () => {
  it("never routes to a specialist the client doesn't have, and says so", async () => {
    const r = await concierge(globex, globexBuilt).ask({ question: "Card or Button for a quick edit?" }, caller);
    expect(r.routing.domains).toEqual(["components"]);
    expect(r.notes.join(" ")).toContain("no patterns specialist");
    const onlyPatterns = await concierge(globex, globexBuilt).ask({ question: "anything", domain: "patterns" }, caller);
    expect(onlyPatterns).toMatchObject({ status: "not-found", specialists: [] });
    expect(onlyPatterns.validation.passed).toBe(true);
  });

  it("cites the client's own markdown rule when a check proves a violation", async () => {
    const r = await concierge(globex, globexBuilt).ask({ question: "Can I hardcode #ffffff for the card background?" }, caller);
    expect(r.status).toBe("escalated");
    expect(r.governance!.findings[0]).toMatchObject({ ruleId: "road-1", check: "raw-color", severity: "high" });
    expect(r.review!.reviewers).toEqual(["globex-ds-owners"]);
  });

  it("only warns about checks the client has no rule for", async () => {
    const r = await concierge(globex, globexBuilt).ask(
      { question: "Is this OK?", code: 'import { keys } from "@/secret/keys"\nexport const x = keys' },
      caller,
    );
    expect(r.governance).toMatchObject({ outcome: "warn" });
    expect(r.governance!.findings.map((f) => [f.check, f.ruleId, f.action])).toEqual([["unapproved-import", null, "warn"]]);
  });

  it("has nothing to flag for what the client doesn't restrict", async () => {
    const r = await concierge(globex, globexBuilt).ask({ question: "Can I use @mui/material for the table?" }, caller);
    expect(r.governance).toMatchObject({ outcome: "no-conflict", findings: [] });
  });

  it("answers the same question differently per client, from each client's contract", async () => {
    const question = { question: "What props does Button take?" };
    const [a, g] = await Promise.all([concierge(acme, acmeBuilt).ask(question, caller), concierge(globex, globexBuilt).ask(question, caller)]);
    expect(a.provenance.client.id).toBe("acme-fixture");
    expect(g.provenance.client.id).toBe("globex-fixture");
    expect(a.components[0]!.import!.path).toBe("@/components/button");
    expect(g.components[0]!.import!.path).toBe("@/components/ui/button");
    expect(a.components[0]!.parts[0]!.props.map((p) => p.name)).toContain("tone");
    expect(g.components[0]!.parts[0]!.props.map((p) => p.name)).not.toContain("tone");
  });
});

describe("isolation checks", () => {
  function workspace() {
    const root = mkdtempSync(join(tmpdir(), "docent-isolation-"));
    const setups = [acme, globex].map((loaded, i) => {
      const built = i === 0 ? acmeBuilt : globexBuilt;
      const config = structuredClone(loaded.config);
      config.output = { dir: join(root, "contracts", config.client.id) };
      const logDir = join(root, "logs", config.client.id);
      mkdirSync(logDir, { recursive: true });
      writeOutputs(config, built.contract, built.sources, { logDir });
      return { loaded: { ...loaded, config }, logDir };
    });
    const logDir = (id: string) => join(root, "logs", id);
    return { root, configs: setups.map((s) => s.loaded), logDir };
  }
  const failed = (results: Awaited<ReturnType<typeof checkIsolation>>) => results.filter((r) => !r.passed).map((r) => `${r.check}${r.client ? `[${r.client}]` : ""}`);

  it("pass for two correctly separated clients", async () => {
    const { configs, logDir } = workspace();
    const results = await checkIsolation(configs, { docentVersion: "test", logDir });
    expect(failed(results)).toEqual([]);
    expect(results.map((r) => r.check)).toEqual(
      expect.arrayContaining(["unique-client-ids", "separate-output-dirs", "contract-owner", "snapshot-matches-contract", "snapshot-from-own-source", "logs-single-client", "no-cross-client-answers", "audit-log-refuses-foreign-entries"]),
    );
  });

  it("catch another client's entry in a log", async () => {
    const { configs, logDir } = workspace();
    appendFileSync(join(logDir("globex-fixture"), "requests.jsonl"), JSON.stringify({ event: "request", client: "acme-fixture" }) + "\n");
    expect(failed(await checkIsolation(configs, { docentVersion: "test", logDir }))).toEqual(["logs-single-client[globex-fixture]"]);
  });

  it("catch shared output folders and a contract that belongs to someone else", async () => {
    const { configs, logDir } = workspace();
    configs[1]!.config.output = { dir: configs[0]!.config.output.dir! };
    expect(failed(await checkIsolation(configs, { docentVersion: "test", logDir }))).toEqual(expect.arrayContaining(["separate-output-dirs", "contract-owner[globex-fixture]"]));
  });

  it("catch a snapshot that doesn't match the client's own source", async () => {
    const { configs, logDir, root } = workspace();
    const copy = join(root, "globex-source");
    cpSync(fixture("globex-ds"), copy, { recursive: true });
    const globexConfig = configs[1]!.config;
    globexConfig.source = { type: "local", path: copy };
    const rebuilt = await buildContract(globexConfig, resolveSource(globexConfig));
    writeOutputs(globexConfig, rebuilt.contract, rebuilt.sources, { logDir: logDir("globex-fixture") });
    writeFileSync(join(copy, "src/lib/utils.ts"), "export const cn = () => ''\n");
    expect(failed(await checkIsolation(configs, { docentVersion: "test", logDir }))).toEqual(["snapshot-from-own-source[globex-fixture]"]);
  });

  it("catch duplicate client ids", async () => {
    const { configs, logDir } = workspace();
    configs[1]!.config.client = { ...configs[0]!.config.client };
    expect(failed(await checkIsolation(configs, { docentVersion: "test", logDir }))).toContain("unique-client-ids");
  });
});
