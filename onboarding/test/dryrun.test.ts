/**
 * Regressions from the Phase 4 dry run on an unseen repo (a Lovable-style app with shadcn/ui,
 * brand palette CSS, a copy-paste token kit, two Toasters and no written rules).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Concierge, MemoryReviewStore, type CallerInfo } from "../../concierge/concierge.js";
import { ClientConfig } from "../../config/schema.js";
import { buildContract, type IngestResult } from "../../ingestion/ingest.js";
import { ComponentIndex } from "../../specialists/components/resolve.js";
import { resolveSource } from "../../ingestion/source.js";
import { detectRepo, type Proposal } from "../detect.js";
import { buildConfig } from "../render.js";

const caller: CallerInfo = { name: "test", client: null, transport: "test" };

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "app", dependencies: { react: "^18.3.1", "class-variance-authority": "^0.7.1" }, devDependencies: { tailwindcss: "^3.4.17", postcss: "^8.4.47" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  "postcss.config.js": "export default { plugins: { tailwindcss: {} } };\n",
  "tailwind.config.ts": `export default {
  theme: { extend: { colors: {
    primary: "hsl(var(--primary))",
    background: "hsl(var(--background))",
    brand: { midnight: "hsl(var(--brand-midnight))" },
  } } },
};
`,
  "src/index.css": `@import "./styles/brand.css";

@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root { --primary: 225 92% 57%; --background: 0 0% 98%; --radius: 0.5rem; }
  .dark { --primary: 225 92% 67%; --background: 222 47% 11%; }
}
`,
  "src/styles/brand.css": `:root {
  --brand-midnight: 227 50% 23%;
  --neutral-500: 220 9% 50%;
  --neutral-600: 220 9% 40%;
}
.bg-neutral-500 { background-color: hsl(var(--neutral-500)); }
.text-neutral-600 { color: hsl(var(--neutral-600) / 0.9); }
`,
  // A copy-paste kit that quotes an entry file's directives in a comment and is imported by nothing.
  "src/styles/kit-tokens.css": `/*
 * Import once, before the Tailwind directives:
 *   @import "./styles/kit-tokens.css";
 *   @tailwind base;
 */
:root { --primary: 0 0% 0%; --background: 0 0% 100%; --card: 0 0% 100%; }
`,
  "src/lib/utils.ts": `export function cn(...inputs: string[]) { return inputs.join(" "); }\n`,
  "src/components/ui/button.tsx": `import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("bg-primary", { variants: { variant: { default: "bg-primary", outline: "border" } }, defaultVariants: { variant: "default" } });

export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  children?: React.ReactNode;
}

export function Button({ variant, children }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant }))}>{children}</button>;
}
`,
  "src/components/ui/sidebar.tsx": `import { cn } from "@/lib/utils";

export function Sidebar({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{ "--sidebar-width": "16rem" } as React.CSSProperties} className={cn("w-[--sidebar-width] bg-background")}>
      {children}
    </div>
  );
}
`,
  "src/components/ui/toaster.tsx": `export function Toaster() {
  return <ol className="bg-background" />;
}
`,
  // An imported kit: PascalCase files, a default export next to the named one, a name the governed kit already uses.
  "src/components/ai/ai-launcher.tsx": `export function AILauncher() {
  return <button className="bg-primary" />;
}
`,
  "src/components/ai/atomic/ai-launcher/AILauncher.tsx": `export function AILauncher({ label }: { label?: string }) {
  return <button className="bg-background">{label}</button>;
}

export default AILauncher;
`,
  "src/components/ui/sonner.tsx": `export const Toaster = () => {
  return <section className="bg-background" />;
};
`,
};

let root: string;
let proposal: Proposal;
let config: ClientConfig;
let built: IngestResult;

function concierge() {
  return new Concierge({
    contract: built.contract,
    sources: built.sources,
    audit: { record() {} },
    policy: config.escalation,
    domains: config.specialists,
    reviews: new MemoryReviewStore(),
    docentVersion: "test",
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "docent-dryrun-"));
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  proposal = await detectRepo(root);
  const generated = buildConfig({ id: "dryrun", name: "Dry Run", source: { type: "local", path: root } }, proposal);
  // Step 5: the owner's rules, recorded in config because the repo has none.
  config = ClientConfig.parse({
    ...generated,
    ingestion: {
      ...generated.ingestion,
      governance: {
        ...generated.ingestion.governance,
        agreedRules: [
          { id: "NO_THIRD_PARTY_UI", rule: "Never add a third-party UI kit such as Material UI.", severity: "critical", agreedBy: "Design owner, 2026-09-11" },
          { id: "TOKEN_COLORS_ONLY", rule: "Use token utilities for color; never hard-code colors.", severity: "high", agreedBy: "Design owner, 2026-09-11" },
        ],
        checks: { "restricted-package": "NO_THIRD_PARTY_UI", "raw-color": "TOKEN_COLORS_ONLY" },
      },
    },
  });
  built = await buildContract(config, resolveSource(config));
});

describe("docent init on a repo like the dry run's", () => {
  it("takes token CSS from what the Tailwind entry imports, and lists the rest for review", () => {
    expect(proposal.ingestion.tokens[0]).toMatchObject({ extractor: "css-variables", include: ["src/index.css", "src/styles/brand.css"] });
    expect(proposal.ingestion.foundation?.files).toContain("src/index.css");
    const todos = proposal.todos.join("\n");
    expect(todos).toContain("src/styles/kit-tokens.css (3 variables) is not imported by src/index.css");
  });

  it("points at agreedRules when the repo has no rules", () => {
    expect(proposal.todos.join("\n")).toContain("governance.agreedRules");
    expect(proposal.ingestion.governance?.agreedRules).toEqual([]);
  });
});

describe("ingesting it", () => {
  it("doesn't report variables a component sets on itself as missing tokens", () => {
    expect(built.contract.gaps.filter((g) => g.kind === "unresolved-token-reference")).toEqual([]);
  });

  it("types HSL-channel variables as colors from how CSS uses them", () => {
    const token = (id: string) => built.contract.tokens.find((t) => t.id === id)!;
    expect(token("neutral-500")).toMatchObject({ type: "color", typeEvidence: "css-usage" });
    expect(token("neutral-600")).toMatchObject({ type: "color", typeEvidence: "css-usage" });
    expect(token("brand-midnight")).toMatchObject({ type: "color", typeEvidence: "tailwind-section" });
    expect(token("radius")).toMatchObject({ type: "dimension", typeEvidence: "value-format" });
  });

  it("reports two components with the same name", () => {
    const gaps = built.contract.gaps.filter((g) => g.kind === "duplicate-component-name");
    expect(gaps.map((g) => g.subject.id).sort()).toEqual(["ai-launcher+AILauncher", "sonner+toaster"]);
  });

  it("records agreed rules with their origin and maps checks to them", () => {
    const rule = built.contract.governance.rules.find((r) => r.id === "NO_THIRD_PARTY_UI");
    expect(rule).toMatchObject({ origin: "agreed", severity: "critical", category: "agreed", reference: "Agreed by Design owner, 2026-09-11", source: { file: "config/clients/dryrun.yaml" } });
    expect(built.contract.governance.checks).toEqual({ "restricted-package": "NO_THIRD_PARTY_UI", "raw-color": "TOKEN_COLORS_ONLY" });
    expect(built.contract.gaps.filter((g) => g.kind === "governance-check-unmapped")).toEqual([]);
  });

  it("rejects an agreed rule whose id the repo already uses", async () => {
    const clash = ClientConfig.parse({
      ...config,
      ingestion: {
        ...config.ingestion,
        governance: { ...config.ingestion.governance, agreedRules: [...config.ingestion.governance!.agreedRules, config.ingestion.governance!.agreedRules[0]] },
      },
    });
    const { contract } = await buildContract(clash, resolveSource(clash));
    expect(contract.governance.rules.filter((r) => r.id === "NO_THIRD_PARTY_UI")).toHaveLength(1);
    expect(contract.gaps.some((g) => g.kind === "unresolvable-config-value" && g.subject.id === "NO_THIRD_PARTY_UI")).toBe(true);
  });
});

describe("an imported kit alongside the governed one", () => {
  it("reads export function X plus export default X as one part", () => {
    const kit = built.contract.components.find((c) => c.id === "AILauncher")!;
    expect(kit.parts.map((p) => [p.name, p.primary])).toEqual([["AILauncher", true]]);
  });

  it("doesn't let a PascalCase id settle a name another component also uses", async () => {
    const byName = await concierge().ask({ question: "What props does AILauncher take?" }, caller);
    expect(byName.status).toBe("clarification-needed");
    expect(byName.validation.passed).toBe(true);
    const byPath = await concierge().ask({ question: "What props does it take?", component: "@/components/ai/atomic/ai-launcher/AILauncher" }, caller);
    expect(byPath.components.map((c) => c.id)).toEqual(["AILauncher"]);
    expect(byPath.validation.passed).toBe(true);
    const fetched = await concierge().getComponent({ components: ["@/components/ai/ai-launcher"] }, caller);
    expect(fetched.components.map((c) => c.id)).toEqual(["ai-launcher"]);
  });

  it("means the inventoried component when only one of the namesakes is in the inventory", () => {
    const contract = structuredClone(built.contract);
    const governed = contract.components.find((c) => c.id === "ai-launcher")!;
    governed.manifest = { id: "ai:ai-launcher", status: null, category: null, notes: {}, source: { file: "components.json" } } as unknown as typeof governed.manifest;
    expect(new ComponentIndex(contract).lookup("AILauncher").map((c) => c.id)).toEqual(["ai-launcher"]);
  });

  it("doesn't match type names written as prose", () => {
    const index = new ComponentIndex(built.contract);
    expect(index.lookup("ButtonProps").map((c) => c.id)).toEqual(["button"]);
    expect(index.lookup("ButtonProps", { typeNames: false })).toEqual([]);
  });
});

describe("serving it", () => {
  it("asks which component is meant when a name is shared, instead of picking one", async () => {
    const r = await concierge().ask({ question: "How do I use the Toaster?" }, caller);
    expect(r.status).toBe("clarification-needed");
    expect(r.clarification?.options.map((o) => o.id).sort()).toEqual(["sonner", "toaster"]);
    expect(r.message).toContain('"Toaster" is exported by 2 components');
    expect(r.validation.passed).toBe(true);

    const byId = await concierge().ask({ question: "How do I use it?", component: "toaster" }, caller);
    expect(byId.status).toBe("answered");
    expect(byId.components.map((c) => c.id)).toEqual(["toaster"]);
  });

  it("delivers the rest of a get_component request and holds back a shared name", async () => {
    const mixed = await concierge().getComponent({ components: ["Toaster", "Button"] }, caller);
    expect(mixed.status).toBe("delivered");
    expect(mixed.components.map((c) => c.id)).toEqual(["button"]);
    expect(mixed.ambiguous.map((a) => [a.name, a.candidates.map((c) => c.id).sort()])).toEqual([["Toaster", ["sonner", "toaster"]]]);
    expect(mixed.unresolved).toEqual([]);
    expect(mixed.validation.passed).toBe(true);

    const only = await concierge().getComponent({ components: ["Toaster"] }, caller);
    expect(only.status).toBe("clarification-needed");
    expect(only.files).toEqual([]);

    const exact = await concierge().getComponent({ components: ["sonner"] }, caller);
    expect(exact.components.map((c) => c.id)).toEqual(["sonner"]);
  });

  it("classifies each utility class a request names", async () => {
    const r = await concierge().ask({ question: "Which tokens do these apply: hover:bg-primary/90 bg-[--brand-midnight] bg-slate-100 text-[#fff] gap-3 border-[--nope]", domain: "tokens" }, caller);
    expect(r.validation.passed).toBe(true);
    expect(r.utilityClasses.map((u) => [u.class, u.kind, u.token])).toEqual([
      ["hover:bg-primary/90", "token", "primary"],
      ["bg-[--brand-midnight]", "token", "brand-midnight"],
      ["bg-slate-100", "palette", null],
      ["text-[#fff]", "arbitrary-color", null],
      ["gap-3", "unbound", null],
      ["border-[--nope]", "unknown-variable", null],
    ]);
  });

  it("audits code without opening a review", async () => {
    const reviews = new MemoryReviewStore();
    const c = new Concierge({ contract: built.contract, sources: built.sources, audit: { record() {} }, policy: config.escalation, domains: config.specialists, reviews, docentVersion: "test" });
    const code = 'import { Button } from "@/components/ui/button"\nexport const X = () => <Button style={{ color: "#1D2955" }}>Go</Button>\n';
    const audited = await c.ask({ question: "Does this follow the design system?", code, audit: true }, caller);
    expect(audited.status).toBe("escalated");
    expect(audited.review).toBeNull();
    expect(audited.validation.passed).toBe(true);
    expect(await reviews.list()).toEqual([]);
    const shipped = await c.ask({ question: "Is this OK to ship?", code }, caller);
    expect(shipped.review?.status).toBe("pending");
    expect(await reviews.list()).toHaveLength(1);
  });

  it("enforces agreed rules like written ones", async () => {
    const mui = await concierge().ask({ question: "Can I use Material UI for the table?" }, caller);
    expect(mui.status).toBe("rejected");
    expect(mui.governance?.findings.map((f) => [f.ruleId, f.action])).toContainEqual(["NO_THIRD_PARTY_UI", "reject"]);

    const hex = await concierge().ask({ question: "Can I hardcode #1D2955 for the header?" }, caller);
    expect(hex.status).toBe("escalated");
  });
});
