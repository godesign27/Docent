/**
 * Builds the folder a deployment is made from: Docent's own source plus one client's config,
 * contract and source snapshot, and nothing of any other client. A container build uploads its
 * whole folder, so the only safe way to keep other clients out of an image is to never put them
 * in the folder.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BundleOptions {
  /** The Docent checkout. */
  root: string;
  clientId: string;
  /** Every client id configured in this checkout, so the bundle can prove none of the others got in. */
  allClientIds: string[];
  /** Files tracked by git in the checkout, relative to root. */
  trackedFiles: string[];
  out: string;
  app?: string;
  region?: string;
}

export interface BundleResult {
  files: string[];
  flyToml: "written" | "kept";
}

const CLIENT_OUTPUTS = ["contract.json", "sources.json", "gaps.md"];

export function bundleClient(options: BundleOptions): BundleResult {
  const { root, clientId, out } = options;
  const isClientFile = (f: string) => /^(config\/clients|contracts|logs)\//.test(f);
  const clientConfig = [`config/clients/${clientId}.yaml`, `config/clients/${clientId}.eval.yaml`].filter((f) => existsSync(join(root, f)));
  if (!clientConfig.includes(`config/clients/${clientId}.yaml`)) throw new Error(`No config for client "${clientId}" at config/clients/${clientId}.yaml.`);
  const outputs = CLIENT_OUTPUTS.map((f) => `contracts/${clientId}/${f}`);
  for (const f of outputs.slice(0, 2)) {
    if (!existsSync(join(root, f))) throw new Error(`${f} is missing. Run: npm run docent -- ingest --client ${clientId}`);
  }

  const files = [
    ...options.trackedFiles.filter((f) => !isClientFile(f) && !/(^|\/)test\//.test(f) && existsSync(join(root, f))),
    "config/clients/_template.yaml",
    "contracts/README.md",
    "logs/README.md",
    ...clientConfig,
    ...outputs.filter((f) => existsSync(join(root, f))),
  ].filter((f, i, all) => all.indexOf(f) === i && existsSync(join(root, f)));

  // Keep a fly.toml from an earlier bundle: it records the app name `fly launch` settled on.
  const flyPath = join(out, "fly.toml");
  const keptFly = existsSync(flyPath) ? readFileSync(flyPath, "utf8") : null;
  rmSync(out, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(join(root, f), join(out, f));
  }

  let flyToml: BundleResult["flyToml"] = "kept";
  if (keptFly) writeFileSync(flyPath, keptFly);
  else {
    const example = readFileSync(join(root, "fly.toml.example"), "utf8");
    writeFileSync(
      flyPath,
      example
        .replace(/^app = ".*"$/m, `app = "${options.app ?? `docent-${clientId}`}"`)
        .replace(/^primary_region = ".*"$/m, `primary_region = "${options.region ?? "iad"}"`)
        .replace(/DOCENT_CLIENT = ".*"/, `DOCENT_CLIENT = "${clientId}"`),
    );
    flyToml = "written";
  }

  assertOnlyClient(out, clientId, options.allClientIds);
  return { files, flyToml };
}

/** Fails if anything belonging to another client is in the folder. */
export function assertOnlyClient(dir: string, clientId: string, allClientIds: string[]): void {
  const others = allClientIds.filter((id) => id !== clientId);
  const leaks: string[] = [];
  for (const sub of ["config/clients", "contracts", "logs"]) {
    const path = join(dir, sub);
    if (!existsSync(path)) continue;
    for (const entry of readdirSync(path)) {
      const id = entry.replace(/(\.eval)?\.(ya?ml|json)$/, "");
      if (others.includes(id)) leaks.push(`${sub}/${entry}`);
    }
  }
  if (leaks.length) throw new Error(`The bundle for ${clientId} contains other clients' files: ${leaks.join(", ")}. Nothing should be deployed from it.`);
}
