import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/load.js";
import type { ClientConfig, EscalationPolicy } from "../../config/schema.js";
import { buildContract } from "../../ingestion/ingest.js";
import { resolveSource } from "../../ingestion/source.js";
import type { Contract } from "../../schema/contract.js";
import type { DocentResponse } from "../../schema/response.js";
import { Concierge, MemoryReviewStore, type AuditEntry, type CallerInfo } from "../concierge.js";
import { runEval, type EvalCase } from "../eval.js";
import { JsonlReviewStore } from "../node.js";
import { validateResponse } from "../validate.js";
import { ContractIndex } from "../../specialists/context.js";
import { checkCode } from "../../specialists/governance/code.js";

const caller: CallerInfo = { name: "test", client: null, transport: "test" };
let contract: Contract;
let config: ClientConfig;
let policy: EscalationPolicy;

function setup(reviews = new MemoryReviewStore()) {
  const audit = { entries: [] as AuditEntry[], record(e: AuditEntry) { this.entries.push(e); } };
  return { audit, reviews, concierge: new Concierge({ contract, audit, reviews, policy, docentVersion: "test" }) };
}
const ask = (question: string, extra: Record<string, unknown> = {}) => setup().concierge.ask({ question, ...extra }, caller);
const ruleIds = (r: DocentResponse) => r.governance?.findings.map((f) => f.ruleId) ?? [];

beforeAll(async () => {
  ({ config } = loadConfig(fileURLToPath(new URL("../../ingestion/test/fixtures/acme.yaml", import.meta.url))));
  policy = config.escalation;
  ({ contract } = await buildContract(config, resolveSource(config)));
});

describe("ingesting patterns, governance and token semantics", () => {
  it("reads patterns through field mappings and flags missing components", () => {
    expect(contract.patterns).toHaveLength(1);
    expect(contract.patterns[0]).toMatchObject({
      id: "confirm-delete",
      name: "Confirm delete",
      intent: "Protect users from irreversible deletion.",
      requiredComponents: ["dialog", "button"],
      unresolvedComponents: ["acme:tooltip"],
      forbidden: ["No single-click deletion", "No tooltip as the only warning surface"],
    });
    expect(contract.gaps.some((g) => g.kind === "pattern-component-missing" && g.subject.id === "confirm-delete")).toBe(true);
  });

  it("reads rules from objects and plain strings, and derives rules from authored guidance", () => {
    const byId = new Map(contract.governance.rules.map((r) => [r.id, r]));
    expect(byId.get("NO_THIRD_PARTY_UI")).toMatchObject({ severity: "critical", category: "core", response: "Use Acme components instead." });
    expect(byId.get("accessibility-1")).toMatchObject({ rule: "Every form control needs a visible label", severity: "medium" });
    expect(byId.get("pattern:confirm-delete:forbidden-2")).toMatchObject({ rule: "No tooltip as the only warning surface", severity: "unspecified", category: "pattern" });
    expect(byId.get("component:acme:button:forbidden-1")).toMatchObject({ rule: "Button: Two primary buttons in one region", category: "component-usage" });
  });

  it("maps checks to rule ids and rejects mappings that don't resolve", () => {
    expect(contract.governance.checks["restricted-package"]).toBe("NO_THIRD_PARTY_UI");
    expect(contract.governance.checks["made-up-check"]).toBeUndefined();
    expect(contract.gaps.some((g) => g.kind === "governance-check-unmapped" && g.message.includes("made-up-check"))).toBe(true);
  });

  it("applies semantic token roles and flags roles for tokens that don't exist", () => {
    const primary = contract.tokens.find((t) => t.id === "primary")!;
    expect(primary).toMatchObject({ role: "action", description: "The main action on a surface." });
    expect(contract.tokens.find((t) => t.id === "ring")).toMatchObject({ role: "focus", description: "Focus indication." });
    expect(contract.tokenGuidance?.decisions).toHaveLength(2);
    expect(contract.gaps.some((g) => g.kind === "semantic-token-missing" && g.subject.id === "brand")).toBe(true);
  });
});

describe("routing", () => {
  const cases: [string, Record<string, unknown>, string[], DocentResponse["status"]][] = [
    ["What props does Button take?", {}, ["components"], "answered"],
    ["Which token is right for the main action?", {}, ["tokens"], "answered"],
    ["What is the dark mode value of --primary?", {}, ["tokens"], "answered"],
    ["How should I build a confirm delete flow?", {}, ["patterns"], "answered"],
    ["Dialog or IconButton for a quick edit?", {}, ["components", "patterns"], "answered"],
    ["What props does Button take and which token colors it?", {}, ["components", "tokens"], "answered"],
    ["Can I use Material UI here?", {}, ["governance"], "rejected"],
    ["Thanks!", {}, [], "clarification-needed"],
    ["anything", { domain: "tokens" }, ["tokens"], "clarification-needed"],
  ];
  it.each(cases)("%s → %j", async (question, extra, domains, status) => {
    const r = await ask(question, extra);
    expect(r.routing.domains).toEqual(domains);
    expect(r.status).toBe(status);
    expect(r.validation.passed).toBe(true);
  });

  it("records the evidence behind every routing decision", async () => {
    const r = await ask("What props does Button take and which token colors it?");
    expect(r.routing.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: "components", signal: "component-named", detail: "Button" }),
        expect.objectContaining({ domain: "tokens", signal: "token-asked-for" }),
      ]),
    );
    expect(r.routing.scores.components).toBeGreaterThanOrEqual(3);
  });

  it("always checks submitted code, even when a domain is forced", async () => {
    const r = await ask("props?", { domain: "components", code: 'import { Button } from "@mui/material"' });
    expect(r.routing.domains).toEqual(["components", "governance"]);
    expect(r.status).toBe("rejected");
  });
});

describe("specialists", () => {
  it("tokens: resolves authored decisions to tokens with values per mode", async () => {
    const r = await ask("Which token is right for the main action?");
    expect(r.tokenDecisions).toEqual([{ need: "The main action", use: "bg-primary text-primary-foreground" }]);
    expect(r.tokens.map((t) => t.id)).toEqual(["primary", "primary-foreground"]);
    expect(r.tokens[0]).toMatchObject({ values: { light: "222 47% 11%", dark: "210 40% 98%" }, meaning: "The main action on a surface.", role: "action" });
    expect(r.tokenForbidden).toEqual(["Raw hex values in class names"]);
  });

  it("tokens: reports tokens that don't exist instead of inventing them", async () => {
    const r = await ask("Is there a --brand token?");
    expect(r).toMatchObject({ status: "not-found", unresolved: ["--brand"], tokens: [] });
  });

  it("patterns: answers with the pattern and its components", async () => {
    const r = await ask("How should I build a confirm delete flow?");
    expect(r.patterns.map((p) => p.id)).toEqual(["confirm-delete"]);
    expect(r.patterns[0]!.requiredComponents.map((c) => c.id)).toEqual(["dialog", "button"]);
  });

  it("patterns: gives usage guidance when comparing components", async () => {
    const r = await ask("Dialog or IconButton for a quick edit?");
    expect(r.usage.map((u) => u.component.id)).toEqual(["dialog", "icon-button"]);
    expect(r.usage[0]).toMatchObject({ whenNotToUse: ["Dialogs that open other dialogs"], patterns: [{ id: "confirm-delete", role: "required" }] });
  });
});

describe("governance on plain-language requests", () => {
  it("rejects a proven critical violation and cites the client's rule and response", async () => {
    const r = await ask("Can I use Material UI here?");
    expect(r.status).toBe("rejected");
    expect(r.governance!.findings[0]).toMatchObject({ ruleId: "NO_THIRD_PARTY_UI", basis: "check", check: "restricted-package", action: "reject", response: "Use Acme components instead." });
    expect(r.message).toContain("Use Acme components instead.");
  });

  it("escalates a proven high violation", async () => {
    const r = await ask("I want to edit the Button source file to add a variant");
    expect(r.status).toBe("escalated");
    expect(ruleIds(r)).toContain("NO_BASE_EDITS");
  });

  it("escalates exception requests, even against critical rules", async () => {
    const r = await ask("Can we make an exception and use @mui/material just this once?");
    expect(r.governance).toMatchObject({ outcome: "needs-review", exceptionRequested: true });
    expect(r.governance!.findings.map((f) => [f.ruleId, f.basis, f.action])).toEqual(
      expect.arrayContaining([
        ["NO_THIRD_PARTY_UI", "check", "reject"],
        ["NO_THIRD_PARTY_UI", "exception-request", "escalate"],
      ]),
    );
    expect(r.status).toBe("escalated");
  });

  it("only warns when a request merely resembles a rule", async () => {
    const r = await ask("Can I nest a dialog inside another dialog?");
    expect(r.governance!.outcome).toBe("warn");
    expect(r.governance!.findings[0]).toMatchObject({ ruleId: "NO_NESTED_DIALOGS", basis: "rule-wording", action: "warn" });
    expect(r.status).toBe("answered");
  });

  it("applies authored guidance from patterns", async () => {
    const r = await ask("Is it OK to use a tooltip as the only warning?");
    expect(ruleIds(r)).toContain("pattern:confirm-delete:forbidden-2");
    expect(r.governance!.outcome).toBe("warn");
  });

  it("does not claim compliance it can't check", async () => {
    const r = await ask("Can I show a welcome message?");
    expect(r.governance).toMatchObject({ outcome: "no-conflict", findings: [] });
    expect(r.governance!.notEvaluated.join(" ")).toContain("rule wording");
  });
});

describe("governance on code", () => {
  const check = (code: string) => ask("Is this OK to ship?", { code });

  it("finds each kind of violation Docent can prove", async () => {
    const r = await check(`import { Box } from "@mui/material"
import { secret } from "@/secret/keys"
import { Card } from "@/components/card"
import { Button, ButtonGroup } from "@/components/button"
import { DialogContent } from "@/components/dialog"

export function Stepper() {
  return null
}

export function Page() {
  return (
    <div className="bg-slate-900 text-[#ff0000]" style={{ color: "#00ff00" }}>
      <Button intent="ghost" tone="solid" wobble>Save</Button>
      <DialogContent />
      <DataGrid />
    </div>
  )
}`);
    const found = r.governance!.findings.map((f) => `${f.check}@${f.line}`);
    expect(found).toEqual(
      expect.arrayContaining([
        "restricted-package@1",
        "unapproved-import@2",
        "unindexed-component@3",
        "unindexed-component@4",
        "palette-utility@13",
        "raw-color@13",
        "invalid-prop-value@14",
        "compound-structure@15",
        "unindexed-component@16",
      ]),
    );
    expect(r.governance!.findings.find((f) => f.check === "invalid-prop-value" && f.evidence.includes("intent"))!.evidence).toContain("must be one of primary, danger");
    expect(r.governance!.findings.some((f) => f.check === "invalid-prop-value" && f.evidence.includes("wobble"))).toBe(false); // Button inherits HTML attributes
    expect(r.status).toBe("rejected");
    expect(r.governance!.checksRun).toContain("compound-structure");
    expect(r.governance!.notEvaluated.join(" ")).toMatch(/Accessibility/);
  });

  it("accepts any of the parents a spec allows", () => {
    const allowing = structuredClone(contract);
    const dialog = allowing.components.find((c) => c.id === "dialog")!;
    (dialog.guidance!.structure as { parts: { parent: string }[] }).parts[0]!.parent = "Sheet | Dialog";
    const code = (wrapper: string) => `import { Dialog, DialogContent } from "@/components/dialog"\nexport const X = () => <${wrapper}><DialogContent /></${wrapper}>\n`;
    const structural = (c: string) => checkCode(c, new ContractIndex(allowing)).findings.filter((f) => f.check === "compound-structure");
    expect(structural(code("Dialog"))).toEqual([]);
    expect(structural(code("section"))).toHaveLength(1);
  });

  it("flags a local component that duplicates an indexed one", async () => {
    const r = await check(`export function Dialog() { return <div role="dialog" /> }`);
    expect(r.governance!.findings[0]).toMatchObject({ check: "bespoke-duplicate", ruleId: "INDEXED_ONLY" });
  });

  it("passes code that follows the design system", async () => {
    const r = await check(`import { Button } from "@/components/button"
import { Dialog, DialogContent } from "@/components/dialog"

export function Confirm() {
  return (
    <Dialog>
      <DialogContent>
        <Button intent="danger" tone="solid">Delete project</Button>
      </DialogContent>
    </Dialog>
  )
}`);
    expect(r.governance).toMatchObject({ outcome: "no-conflict", findings: [] });
    expect(r.status).toBe("answered");
  });
});

describe("escalation and human review", () => {
  it("withholds the answer, opens a review, and reports the decision once made", async () => {
    const { concierge, reviews, audit } = setup();
    const r = await concierge.ask({ question: "I want to edit the Button source file to add a variant", caller: "cursor" }, caller);
    expect(r.status).toBe("escalated");
    expect(r.components).toEqual([]);
    expect(r.review).toMatchObject({ status: "pending", reviewers: ["acme-ds-team"] });
    expect(audit.entries[0]).toMatchObject({ reviewId: r.review!.id, flagged: true });
    expect(audit.entries[0]!.flags).toContain("escalated-for-review");

    const stored = (await reviews.get(r.review!.id))!;
    expect(stored).toMatchObject({ status: "pending", requestId: r.requestId, request: { question: "I want to edit the Button source file to add a variant" } });

    expect((await concierge.checkReview({ reviewId: r.review!.id }, caller)).status).toBe("pending");
    await reviews.decide(r.review!.id, { status: "approved", by: "sam", note: "Add it as variant brand; update the spec too." });
    const decided = await concierge.checkReview({ reviewId: r.review!.id }, caller);
    expect(decided).toMatchObject({ status: "approved", review: { decision: { by: "sam" } } });
    expect(decided.message).toContain("update the spec too");
    expect((await concierge.checkReview({ reviewId: "rev_nope" }, caller)).status).toBe("not-found");
  });

  it("keeps reviews in an append-only log per client", () => {
    const path = join(mkdtempSync(join(tmpdir(), "docent-reviews-")), "reviews.jsonl");
    const store = new JsonlReviewStore(path, "acme-fixture");
    const review = {
      id: "rev_1", client: "acme-fixture", requestId: "req", createdAt: new Date().toISOString(), status: "pending" as const,
      caller: "test", request: { question: "q" }, outcome: "needs-review" as const, findings: [], decision: null,
    };
    store.create(review);
    expect(new JsonlReviewStore(path, "acme-fixture").get("rev_1")?.status).toBe("pending");
    store.decide("rev_1", { status: "denied", by: "sam", note: "no" });
    expect(new JsonlReviewStore(path, "acme-fixture").get("rev_1")).toMatchObject({ status: "denied", decision: { by: "sam", note: "no" } });
    expect(() => store.decide("rev_1", { status: "approved", by: "kim", note: "yes" })).toThrow(/already denied/);
    expect(() => new JsonlReviewStore(path, "other-client").create({ ...review, id: "rev_2" })).toThrow(/Refusing/);
  });
});

describe("validation of Phase 2 answers", () => {
  const failures = (r: DocentResponse) => validateResponse(r, contract, policy).checks.filter((c) => !c.passed).flatMap((c) => c.failures).join("\n");

  it("catches misquoted rules, wrong actions and outcomes, and leaked answers", async () => {
    const tamper = async (question: string, change: (r: DocentResponse) => void, extra: Record<string, unknown> = {}) => {
      const r = await ask(question, extra);
      change(r);
      return failures(r);
    };
    expect(await tamper("Can I use Material UI here?", (r) => (r.governance!.findings[0]!.action = "warn"))).toMatch(/policy gives reject/);
    expect(await tamper("Can I use Material UI here?", (r) => (r.governance!.findings[0]!.rule = "Anything goes"))).toMatch(/misquotes/);
    expect(await tamper("Can I use Material UI here?", (r) => (r.governance!.findings[0]!.ruleId = "MADE_UP"))).toMatch(/not a rule in the contract/);
    expect(await tamper("Can I use Material UI here?", (r) => (r.governance!.outcome = "no-conflict"))).toMatch(/does not follow from the findings/);
    expect(
      await tamper("I want to edit the Button source file to add a variant", (r) => r.patterns.push({ ...contract.patterns[0]!, requiredComponents: [], recommendedComponents: [], optionalComponents: [] } as never)),
    ).toMatch(/must not carry answers/);
    expect(await tamper("I want to edit the Button source file to add a variant", (r) => (r.review = null))).toMatch(/pending review/);
    expect(await tamper("Which token is right for the main action?", (r) => (r.tokens[0]!.values.dark = "0 0% 0%"))).toMatch(/values differ/);
    expect(await tamper("Which token is right for the main action?", (r) => r.tokenDecisions.push({ need: "Anything", use: "bg-red-500" }))).toMatch(/was not authored/);
    expect(await tamper("How should I build a confirm delete flow?", (r) => r.patterns[0]!.forbidden.pop())).toMatch(/differs from the contract/);
  });
});

describe("evaluation runner", () => {
  it("scores a batch and explains mismatches", async () => {
    const batch: EvalCase[] = [
      { ask: "What props does Button take?", expect: { domains: ["components"], components: ["button"] } },
      { ask: "Can I use Material UI here?", expect: { status: "rejected", rules: ["NO_THIRD_PARTY_UI"] } },
      { ask: "What props does Button take?", expect: { domains: ["tokens"] } },
    ];
    const results = await runEval(contract, policy, batch, "test");
    expect(results.map((r) => r.passed)).toEqual([true, true, false]);
    expect(results[2]!.failures[0]).toBe("routed to components, expected tokens");
  });
});
