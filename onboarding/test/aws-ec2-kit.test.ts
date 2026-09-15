/**
 * The AWS EC2 kit can't run in CI, so this checks what can be checked without AWS: every file the guide
 * refers to exists, JSON and YAML parse, shell scripts parse, the container isn't root, and the kit holds
 * placeholders rather than anything that looks like a real account, key or token.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const KIT = fileURLToPath(new URL("../../deploy/aws-ec2/", import.meta.url));
const read = (file: string) => readFileSync(join(KIT, file), "utf8");

function kitFiles(dir = KIT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? kitFiles(path) : [relative(KIT, path)];
  });
}

describe("AWS EC2 deployment kit", () => {
  it("has every file the guide and the pipeline refer to", () => {
    const expected = [
      "README.md",
      "INSTALL.md",
      "AGENT_INSTRUCTIONS.md",
      "IT_BRIEF.md",
      "Dockerfile",
      "bitbucket-pipelines.yml",
      "ci/aws-oidc.sh",
      "ci/build-and-push.sh",
      "ci/deploy-via-ssm.sh",
      "ec2/bootstrap.sh",
      "iam/instance-role-policy.json",
      "iam/pipeline-role-policy.json",
      "iam/pipeline-trust-policy.json",
      "cursor/mcp.json.example",
    ];
    for (const file of expected) expect(existsSync(join(KIT, file)), file).toBe(true);

    const pipeline = parse(read("bitbucket-pipelines.yml")) as { pipelines: { custom: Record<string, { step: { script: string[] } }[]> } };
    const scripts = pipeline.pipelines.custom["ingest-and-deploy"]!.flatMap((s) => s.step.script);
    const referenced = scripts.flatMap((line) => line.match(/deploy\/aws-ec2\/[\w./-]+\.sh/g) ?? []);
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced) expect(existsSync(join(KIT, "../..", path)), path).toBe(true);
  });

  it("has policies and settings that parse", () => {
    for (const file of kitFiles().filter((f) => f.endsWith(".json") || f.endsWith(".json.example"))) {
      expect(() => JSON.parse(read(file)), file).not.toThrow();
    }
    expect(JSON.parse(read("iam/pipeline-role-policy.json")).Statement.map((s: { Sid: string }) => s.Sid)).toContain("DeployOnlyToTheTaggedHost");
  });

  it("has shell scripts that parse and stop on the first error", () => {
    for (const file of kitFiles().filter((f) => f.endsWith(".sh"))) {
      expect(() => execFileSync("bash", ["-n", join(KIT, file)]), file).not.toThrow();
      expect(read(file), file).toContain("set -euo pipefail");
    }
  });

  it("runs the container as a non-root user", () => {
    expect(read("Dockerfile")).toMatch(/^USER node$/m);
  });

  it("holds placeholders, not real account ids, keys or tokens", () => {
    for (const file of kitFiles()) {
      const text = read(file);
      expect(text, `${file}: 12-digit account id`).not.toMatch(/\b\d{12}\b/);
      expect(text, `${file}: AWS access key`).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
      expect(text, `${file}: private key`).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, `${file}: GitHub token`).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
      expect(text, `${file}: literal bearer token`).not.toMatch(/Bearer [A-Za-z0-9+/=]{24,}/);
    }
  });
});
