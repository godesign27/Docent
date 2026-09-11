import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertOnlyClient, bundleClient } from "../bundle.js";

function checkout(): { root: string; tracked: string[] } {
  const root = mkdtempSync(join(tmpdir(), "docent-bundle-"));
  const files: Record<string, string> = {
    "package.json": "{}",
    Dockerfile: "FROM node:22-slim\n",
    "fly.toml.example": 'app = "docent-CLIENT-ID"\nprimary_region = "iad"\n\n[env]\n  DOCENT_CLIENT = "CLIENT-ID"\n',
    "cli/index.ts": "export {}\n",
    "ingestion/test/fixture.ts": "export {}\n",
    "config/clients/_template.yaml": "# template\n",
    "config/clients/alpha.yaml": "client: { id: alpha }\n",
    "config/clients/alpha.eval.yaml": "[]\n",
    "config/clients/beta.yaml": "client: { id: beta }\n",
    "contracts/README.md": "# contracts\n",
    "contracts/alpha/contract.json": "{}",
    "contracts/alpha/sources.json": "{}",
    "contracts/beta/contract.json": '{"secret": true}',
    "contracts/beta/sources.json": "{}",
    "logs/README.md": "# logs\n",
    "logs/alpha/requests.jsonl": "{}\n",
    "logs/beta/requests.jsonl": "{}\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  // A clone that mistakenly committed another client's config must still not leak it.
  const tracked = ["package.json", "Dockerfile", "fly.toml.example", "cli/index.ts", "ingestion/test/fixture.ts", "config/clients/_template.yaml", "config/clients/beta.yaml", "contracts/README.md", "logs/README.md"];
  return { root, tracked };
}

describe("docent bundle", () => {
  it("contains Docent and the one client, and nothing of any other", () => {
    const { root, tracked } = checkout();
    const out = join(root, ".deploy/alpha");
    const result = bundleClient({ root, clientId: "alpha", allClientIds: ["alpha", "beta"], trackedFiles: tracked, out, app: "docent-alpha-test", region: "den" });
    expect(result.files.sort()).toEqual(
      ["Dockerfile", "cli/index.ts", "config/clients/_template.yaml", "config/clients/alpha.eval.yaml", "config/clients/alpha.yaml", "contracts/README.md", "contracts/alpha/contract.json", "contracts/alpha/sources.json", "fly.toml.example", "logs/README.md", "package.json"].sort(),
    );
    expect(existsSync(join(out, "contracts/beta"))).toBe(false);
    expect(existsSync(join(out, "config/clients/beta.yaml"))).toBe(false);
    expect(existsSync(join(out, "logs/alpha"))).toBe(false);
    expect(existsSync(join(out, "ingestion/test"))).toBe(false);
    expect(readFileSync(join(out, "fly.toml"), "utf8")).toContain('app = "docent-alpha-test"');
    expect(readFileSync(join(out, "fly.toml"), "utf8")).toContain('DOCENT_CLIENT = "alpha"');
    expect(readFileSync(join(out, "fly.toml"), "utf8")).toContain('primary_region = "den"');
  });

  it("keeps the fly.toml from an earlier bundle", () => {
    const { root, tracked } = checkout();
    const out = join(root, ".deploy/alpha");
    bundleClient({ root, clientId: "alpha", allClientIds: ["alpha", "beta"], trackedFiles: tracked, out });
    writeFileSync(join(out, "fly.toml"), 'app = "docent-alpha-renamed"\n');
    expect(bundleClient({ root, clientId: "alpha", allClientIds: ["alpha", "beta"], trackedFiles: tracked, out }).flyToml).toBe("kept");
    expect(readFileSync(join(out, "fly.toml"), "utf8")).toBe('app = "docent-alpha-renamed"\n');
  });

  it("refuses to bundle a client that hasn't been ingested", () => {
    const { root, tracked } = checkout();
    expect(() => bundleClient({ root, clientId: "gamma", allClientIds: ["alpha", "beta", "gamma"], trackedFiles: tracked, out: join(root, "out") })).toThrow(/No config/);
  });

  it("catches another client's files in a folder", () => {
    const { root } = checkout();
    expect(() => assertOnlyClient(root, "alpha", ["alpha", "beta"])).toThrow(/config\/clients\/beta.yaml, contracts\/beta, logs\/beta/);
  });
});
