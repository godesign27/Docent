import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../config/load.js";
import { Contract, type ComponentContract, type Gap, type TokenContract } from "../../schema/contract.js";
import { findFiles } from "../files.js";
import { buildContract } from "../ingest.js";
import { diffContracts, renderReport } from "../report.js";
import { resolveSource } from "../source.js";

const fixtureConfig = fileURLToPath(new URL("./fixtures/acme.yaml", import.meta.url));

let contract: Contract;
const component = (id: string): ComponentContract => {
  const found = contract.components.find((c) => c.id === id);
  if (!found) throw new Error(`component ${id} not in contract`);
  return found;
};
const token = (id: string): TokenContract => {
  const found = contract.tokens.find((t) => t.id === id);
  if (!found) throw new Error(`token ${id} not in contract`);
  return found;
};
const gapsFor = (id: string, kind?: Gap["kind"]) =>
  contract.gaps.filter((g) => g.subject.id === id && (!kind || g.kind === kind));

beforeAll(async () => {
  const { config } = loadConfig(fixtureConfig);
  contract = await buildContract(config, resolveSource(config));
});

describe("contract", () => {
  it("validates against the schema and is deterministic", async () => {
    expect(() => Contract.parse(contract)).not.toThrow();
    const { config } = loadConfig(fixtureConfig);
    const again = await buildContract(config, resolveSource(config));
    expect(again.contentHash).toBe(contract.contentHash);
    expect(diffContracts(contract, again).unchanged).toBe(true);
  });

  it("finds every component module and token", () => {
    expect(contract.components.map((c) => c.id)).toEqual(["button", "dialog", "icon-button", "stepper"]);
    expect(contract.modes).toEqual(["light", "dark"]);
    expect(contract.stats.tokens).toBe(contract.tokens.length);
  });
});

describe("components", () => {
  it("extracts declared props, cva variants, defaults and JSDoc", () => {
    const button = component("button");
    const part = button.parts[0]!;
    expect(part).toMatchObject({ name: "Button", primary: true, element: 'Slot | "button"' });
    expect(part.extends).toEqual(["React.ButtonHTMLAttributes<HTMLButtonElement>"]);
    expect(part.description).toBe("Triggers an action. Use for the primary call to action on a surface.");

    const props = Object.fromEntries(part.props.map((p) => [p.name, p]));
    expect(props.asChild).toMatchObject({ type: "boolean", required: false, default: "false", description: "Render the child element instead of a button.", origin: "declared" });
    expect(props.tone).toMatchObject({ required: true, values: ["solid", "subtle"] });
    expect(props.intent).toMatchObject({ origin: "variant", values: ["primary", "danger"], default: "primary" });
    expect(props.size).toMatchObject({ origin: "variant", values: ["sm", "md"], default: "md" });

    expect(button.otherExports).toEqual(["buttonVariants"]);
    expect(button.dependencies).toEqual(["@radix-ui/react-slot", "class-variance-authority"]);
    expect(button.importPath).toBe("@/components/button");
    expect(button.importPathSource).toBe("tsconfig-paths");
  });

  it("links variants imported from another module", () => {
    const part = component("icon-button").parts[0]!;
    expect(part.variants.map((v) => v.name)).toEqual(["intent", "size"]);
    expect(part.variants[0]!.source.file).toBe("src/components/button.tsx");
    expect(part.extends).toEqual([]);
    expect(part.props.map((p) => p.name)).toEqual(["intent", "label", "size"]);
  });

  it("records primitive aliases and inherited props without expanding them", () => {
    const dialog = component("dialog");
    expect(dialog.parts.map((p) => p.name)).toEqual(["Dialog", "DialogContent"]);
    expect(dialog.parts[0]).toMatchObject({ primary: true, element: "DialogPrimitive.Root" });
    expect(dialog.parts[1]!.extends).toEqual(["React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>"]);
    expect(dialog.otherExports).toEqual(["DIALOG_Z"]);
    expect(gapsFor("dialog", "inherited-props-not-expanded")[0]?.message).toContain("@radix-ui/react-dialog");
  });

  it("flags untyped props and families without a primary export", () => {
    expect(gapsFor("stepper", "props-not-resolved")).toHaveLength(1);
    expect(gapsFor("stepper", "no-primary-export")).toHaveLength(1);
    expect(component("stepper").parts.every((p) => !p.primary)).toBe(true);
  });

  it("merges the manifest and drops placeholders instead of passing them on", () => {
    expect(component("button").manifest).toMatchObject({ id: "acme:button", status: "stable", category: "Actions", notes: { a11y: "Use a real button element for actions." } });
    expect(component("dialog").manifest).toMatchObject({ status: "stable", category: null, notes: {} });
    expect(gapsFor("dialog", "placeholder-documentation")[0]?.message).toContain("category, a11y");
    expect(gapsFor("stepper", "not-in-manifest")).toHaveLength(1);
    expect(gapsFor("acme:tooltip", "manifest-entry-without-source")).toHaveLength(1);
  });

  it("attaches docs by file name or heading, ignoring headings in code blocks", () => {
    expect(component("button").docs.map((d) => d.file)).toEqual(["docs/button.md"]);
    const dialogDocs = component("dialog").docs;
    expect(dialogDocs).toHaveLength(1);
    expect(dialogDocs[0]!.content).toContain("### Focus");
    expect(dialogDocs[0]!.content).not.toContain("Popover");
    expect(gapsFor("stepper", "missing-usage-docs")).toHaveLength(1);
    expect(gapsFor("button", "missing-usage-docs")).toHaveLength(0);
  });

  it("traces styles to tokens and flags values that are not tokens", () => {
    expect(component("button").tokenRefs).toEqual(["primary", "primary-foreground", "ring", "tailwind.borderRadius.md", "tailwind.colors.danger"]);
    expect(gapsFor("button", "non-token-value")[0]?.message).toContain("text-white");
    expect(gapsFor("icon-button", "non-token-value")[0]?.message).toMatch(/bg-\[#ff00aa\].*text-slate-500/);
    expect(gapsFor("dialog", "non-token-value")[0]?.message).toContain("bg-black/80");
    expect(gapsFor("dialog", "unresolved-token-reference")[0]?.message).toContain("--dialog-width");
    expect(component("dialog").tokenRefs).toContain("radius");
  });
});

describe("specs", () => {
  it("attaches authored guidance and drops placeholders", () => {
    const guidance = component("button").guidance!;
    expect(guidance).toMatchObject({
      id: "acme:button",
      lifecycle: "stable",
      intent: "Commit to the main action on a surface.",
      forbiddenUsage: ["Two primary buttons in one region"],
      agentRules: ["Label with a verb naming the outcome."],
      accessibility: { role: "button" },
      knownGaps: ["No loading spinner styles yet"],
    });
    expect(guidance.propHints).toEqual({ intent: "danger only for destructive actions.", asChild: "Use for links that must look like a button." });
    expect(component("dialog").guidance?.structure).toMatchObject({ root: "Dialog" });
    expect(component("button").typeExports).toEqual(["ButtonProps"]);
  });

  it("reports drift where the spec disagrees with source, and keeps source", () => {
    expect(gapsFor("button", "spec-drift").map((g) => g.id)).toEqual(["spec-drift:component:button:required-props"]);
    expect(gapsFor("button", "spec-drift")[0]!.message).toContain("Button.tone");
    const dialogDrift = gapsFor("dialog", "spec-drift")[0]!.message;
    expect(dialogDrift).toContain("exports missing from spec: `DIALOG_Z`");
    expect(dialogDrift).toContain("exports in spec but not in source: `DialogClose`");
    expect(component("dialog").parts.map((p) => p.name)).toEqual(["Dialog", "DialogContent"]);
  });

  it("flags components without specs and specs without components", () => {
    expect(gapsFor("stepper", "spec-missing")).toHaveLength(1);
    expect(gapsFor("acme:tooltip", "spec-without-source")).toHaveLength(1);
  });
});

describe("tokens", () => {
  it("merges CSS modes with Tailwind bindings", () => {
    expect(token("primary")).toMatchObject({
      cssVariable: "--primary",
      type: "color",
      typeEvidence: "tailwind-section",
      category: "color",
      documented: true,
    });
    expect(token("primary").values.light).toMatchObject({ raw: "222 47% 11%", format: "hsl-channels" });
    expect(token("primary").values.dark?.raw).toBe("210 40% 98%");
    expect(token("primary").tailwind[0]).toMatchObject({ section: "colors", key: "primary", exampleClasses: ["bg-primary", "text-primary", "border-primary"] });
    expect(token("radius").tailwind.map((b) => b.key)).toEqual(["lg"]);
  });

  it("keeps derived Tailwind values as their own tokens with references", () => {
    expect(token("tailwind.borderRadius.md")).toMatchObject({ references: ["radius"], category: "radius", type: "dimension" });
    expect(token("tailwind.fontFamily.mono").values.light?.raw).toBe("JetBrains Mono, monospace");
    expect(contract.tokens.some((t) => t.id.includes("keyframes"))).toBe(false);
  });

  it("flags computed Tailwind values instead of evaluating the config", () => {
    const gap = contract.gaps.find((g) => g.kind === "unresolvable-config-value" && g.message.includes("fontFamily.sans"));
    expect(gap).toBeDefined();
    expect(contract.tokens.some((t) => t.id === "tailwind.fontFamily.sans")).toBe(false);
  });

  it("follows the cascade for duplicates and flags the conflict", () => {
    expect(token("ring").values.light?.raw).toBe("#1d4ed8");
    expect(gapsFor("ring", "conflicting-token-definition")).toHaveLength(1);
  });

  it("resolves alias types and flags broken references", () => {
    expect(token("focus-ring")).toMatchObject({ type: "color", references: ["ring"] });
    expect(gapsFor("tailwind.colors.danger", "unresolved-token-reference")).toHaveLength(1);
    expect(gapsFor("space.gutter", "unresolved-token-reference")[0]?.message).toContain("space.missing");
    expect(gapsFor("space.gutter", "unknown-token-type")).toHaveLength(1);
  });

  it("reads DTCG and Style Dictionary JSON", () => {
    expect(token("motion.fast")).toMatchObject({ type: "duration", typeEvidence: "declared", description: "Hover and press feedback", category: "motion", documented: true });
    expect(token("motion.slow")).toMatchObject({ type: "duration", references: ["motion.fast"] });
    expect(token("space.4")).toMatchObject({ type: "dimension", category: "spacing" });
  });

  it("flags missing default modes, unmapped selectors and undocumented tokens", () => {
    expect(gapsFor("overlay", "missing-default-mode")).toHaveLength(1);
    expect(contract.gaps.some((g) => g.kind === "unresolvable-config-value" && g.message.includes(".brand-sunset"))).toBe(true);
    expect(gapsFor("overlay", "undocumented-token")).toHaveLength(1);
    expect(contract.tokens.some((t) => t.id.startsWith("tw-") || t.id.startsWith("radix-"))).toBe(false);
  });
});

describe("report", () => {
  it("renders gaps grouped by severity and kind", () => {
    const md = renderReport(contract, diffContracts(null, contract));
    expect(md).toContain("# Docent ingestion report — Acme Fixture");
    expect(md).toContain("First ingestion for this client.");
    expect(md).toMatch(/### Errors \(\d+\)/);
    expect(md).toContain("#### `unresolved-token-reference`");
  });
});

describe("safety", () => {
  it("rejects globs that escape the design-system root", async () => {
    const root = fileURLToPath(new URL("./fixtures/acme-ds", import.meta.url));
    await expect(findFiles(root, ["../**/*.yaml"])).rejects.toThrow(/may not contain/);
    await expect(findFiles(root, ["/etc/*"])).rejects.toThrow(/relative/);
  });

  it("reports invalid configs clearly", () => {
    expect(() => loadConfig(fileURLToPath(new URL("./fixtures/acme-ds/components.json", import.meta.url)))).toThrow(ConfigError);
  });
});
