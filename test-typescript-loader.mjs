import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

function expandPath(value, fallback) {
  const rawValue = typeof value === "string" && value.trim() ? value : fallback;
  const raw = rawValue.trim();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

function npmGlobalRoot() {
  try {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    return execFileSync(command, ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function packageRootFromModule(value) {
  if (!value?.trim()) return undefined;
  const candidate = resolvePath(expandPath(value, value));
  if (candidate.endsWith(`${process.platform === "win32" ? "\\" : "/"}index.js`)) return dirname(dirname(candidate));
  return candidate;
}

function firstPackageRoot(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "package.json"))) return candidate;
  }
  return candidates.find(Boolean);
}

// Pi installs user packages below the configured agent directory. Resolve all
// test imports from that directory so the loader works on either OS. The
// loader also supports a standalone checkout: repo-local node_modules wins,
// and sources inside this repository get the .js -> .ts rewrite.
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolvePath(expandPath(process.env.PI_CODING_AGENT_DIR, join(homedir(), ".pi", "agent")));
const EXTENSIONS_ROOT = resolvePath(join(AGENT_ROOT, "extensions"));
const globalRoot = npmGlobalRoot();
const nodeInstallRoot = resolvePath(join(dirname(dirname(process.execPath)), "lib", "node_modules"));
const PI_CODING_AGENT_ROOT = firstPackageRoot([
  packageRootFromModule(process.env.PI_CODING_AGENT_MODULE),
  join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
  join(AGENT_ROOT, "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
  globalRoot && join(globalRoot, "@earendil-works", "pi-coding-agent"),
  join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent"),
  join(nodeInstallRoot, "@earendil-works", "pi-coding-agent"),
]);
if (!PI_CODING_AGENT_ROOT) throw new Error("Could not locate @earendil-works/pi-coding-agent; set PI_CODING_AGENT_MODULE");
const piAiCandidates = [
  join(PI_CODING_AGENT_ROOT, "node_modules", "@earendil-works", "pi-ai"),
  join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai"),
];
const PI_AI_ROOT = piAiCandidates.find((candidate) => existsSync(join(candidate, "package.json")));
if (!PI_AI_ROOT) throw new Error("Could not locate @earendil-works/pi-ai next to pi-coding-agent");
const PI_AI_DIST = `${pathToFileURL(join(PI_AI_ROOT, "dist")).href}/`;
const PI_CODING_AGENT_DIST = `${pathToFileURL(join(PI_CODING_AGENT_ROOT, "dist")).href}/`;
const firstExisting = (candidates) => candidates.find((candidate) => existsSync(candidate));
const TYPEBOX = pathToFileURL(firstExisting([
  join(PI_CODING_AGENT_ROOT, "node_modules", "typebox", "build", "index.mjs"),
  join(REPO_ROOT, "node_modules", "typebox", "build", "index.mjs"),
]) ?? join(PI_CODING_AGENT_ROOT, "node_modules", "typebox", "build", "index.mjs")).href;
const YAML = pathToFileURL(firstExisting([
  join(PI_CODING_AGENT_ROOT, "node_modules", "yaml", "dist", "index.js"),
  join(REPO_ROOT, "node_modules", "yaml", "dist", "index.js"),
]) ?? join(PI_CODING_AGENT_ROOT, "node_modules", "yaml", "dist", "index.js")).href;



export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-ai") return nextResolve(`${PI_AI_DIST}index.js`, context);
  if (specifier === "@earendil-works/pi-ai/compat") return nextResolve(`${PI_AI_DIST}compat.js`, context);
  if (specifier === "@earendil-works/pi-coding-agent") return nextResolve(`${PI_CODING_AGENT_DIST}index.js`, context);
  if (specifier === "typebox") return nextResolve(TYPEBOX, context);
  if (specifier === "yaml") return nextResolve(YAML, context);
  // Relative .js specifiers may name TypeScript sources: try the literal path
  // first, then fall back to the .ts twin. The fallback is parent-agnostic so
  // sources reached through node_modules symlinks (file: dependencies on
  // sibling checkouts) rewrite exactly like repo-local sources.
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      try {
        return await nextResolve(specifier.slice(0, -3) + ".ts", context);
      } catch {
        throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}
