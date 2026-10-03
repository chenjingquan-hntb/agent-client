/** Offline phase gate: tests and syntax checks only; never build or run a release. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const environment = { ...process.env };
// Noninteractive Bash must not source a user's startup script, even for -n.
for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"]) delete environment[name];

function capture(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    throw new Error(`${command.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function findBash(): string {
  if (process.platform !== "win32") {
    const bash = Bun.which("bash");
    if (!bash) throw new Error("bash is required on PATH");
    return bash;
  }
  // Git for Windows puts its own Bash under usr/bin; PATH may instead expose
  // the Windows WSL launcher. Ask the installed Git, not a machine-local drive.
  const execPath = capture(["git", "--exec-path"]).trim();
  const candidates = [
    resolve(execPath, "../../../usr/bin/bash.exe"),
    resolve(execPath, "../../bin/bash.exe"),
  ];
  const bash = candidates.find(existsSync);
  if (!bash) throw new Error("Git for Windows Bash was not found relative to git --exec-path");
  return bash;
}

function checkBash(bash: string, label: string, source: string): void {
  // stdin avoids MSYS/Windows path conversion; -n parses without executing.
  const result = Bun.spawnSync([bash, "--noprofile", "--norc", "-n"], {
    cwd: root, env: environment, stdin: Buffer.from(source.replace(/\r\n/g, "\n")),
    stdout: "pipe", stderr: "pipe",
  });
  if (!result.success) throw new Error(`${label}: bash -n failed (${result.exitCode}): ${result.stderr.toString()}`);
}

type Mapping = Record<string, unknown>;
function mapping(value: unknown, label: string): Mapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected a YAML mapping`);
  return value as Mapping;
}

function defaultsShell(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const run = mapping(value, label).run;
  if (run === undefined) return undefined;
  const shell = mapping(run, `${label}.run`).shell;
  if (shell === undefined) return undefined;
  if (typeof shell !== "string") throw new Error(`${label}: shell must be a string`);
  return shell;
}

function placeholderExpressions(source: string): string {
  // GitHub string literals can contain "}}"; do not end an expression there.
  // The replacement is inert inside unquoted, single-quoted and double-quoted Bash.
  let output = "";
  let cursor = 0;
  for (;;) {
    const start = source.indexOf("${{", cursor);
    if (start === -1) return output + source.slice(cursor);
    output += source.slice(cursor, start);
    let quoted = false;
    let end = start + 3;
    for (; end < source.length; end++) {
      if (source[end] === "'") {
        if (quoted && source[end + 1] === "'") { end++; continue; }
        quoted = !quoted;
      } else if (!quoted && source.startsWith("}}", end)) break;
    }
    if (end === source.length) throw new Error("Unterminated GitHub expression in run block");
    output += "GITHUB_EXPRESSION_PLACEHOLDER";
    cursor = end + 2;
  }
}

function workflowBash(bash: string, path: string): { checked: number; skipped: number } {
  const workflow = mapping(Bun.YAML.parse(readFileSync(resolve(root, path), "utf8")), path);
  const jobs = mapping(workflow.jobs, `${path}.jobs`);
  const workflowShell = defaultsShell(workflow.defaults, `${path}.defaults`);
  let checked = 0;
  let skipped = 0;
  for (const [id, value] of Object.entries(jobs)) {
    const job = mapping(value, `${path}:${id}`);
    if (job.steps === undefined && job.uses !== undefined) continue; // Reusable workflow, no local run blocks.
    if (!Array.isArray(job.steps)) throw new Error(`${path}:${id}: expected steps`);
    const jobShell = defaultsShell(job.defaults, `${path}:${id}.defaults`) ?? workflowShell;
    for (const [index, value] of job.steps.entries()) {
      const label = `${path}:${id}:step ${index + 1}`;
      const step = mapping(value, label);
      if (step.run === undefined) continue;
      if (typeof step.run !== "string") throw new Error(`${label}: run must be a string`);
      const shell = step.shell ?? jobShell;
      if (shell !== undefined && typeof shell !== "string") throw new Error(`${label}: shell must be a string`);
      if (typeof shell === "string" && shell.includes("${{")) throw new Error(`${label}: dynamic shell cannot be checked offline`);
      const runner = job["runs-on"];
      // GitHub defaults to pwsh on Windows, Bash on Linux/macOS. Fail closed
      // for an ambiguous runner instead of silently omitting potential Bash.
      if (shell === undefined && (typeof runner !== "string" || !/^(ubuntu|macos|windows)-/.test(runner))) {
        throw new Error(`${label}: ambiguous runner; set an explicit shell`);
      }
      const isBash = typeof shell === "string" ? /^bash(?:\s|$)/.test(shell.trim()) : !String(runner).startsWith("windows-");
      if (!isBash) { skipped++; continue; }
      checkBash(bash, label, placeholderExpressions(step.run));
      checked++;
    }
  }
  if (!checked) throw new Error(`${path}: no Bash run blocks found`);
  console.log(`[phase] ${path}: YAML parsed; ${checked} Bash run blocks checked, ${skipped} non-Bash skipped`);
  return { checked, skipped };
}

const testFiles = [
  "scripts/brand-config.test.ts",
  "scripts/release-channel.test.ts",
  "scripts/release-channel-cli.test.ts",
  "docs/contracts/fixtures.test.ts",
];
// Always parse the phase's TS even in a clean CI checkout, plus modified,
// staged and untracked TS/TSX source files in a developer checkout.
const phaseTypescript = [
  ...testFiles,
  "scripts/brand-config.ts", "scripts/release-channel.ts",
  "scripts/appcast.ts", "scripts/appcast-windows.ts",
  "scripts/bundle-windows.ts", "scripts/release.ts",
  "scripts/validate-client-phase.ts",
];
const sourceExtensions = new Set([".rs", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".sh"]);
function inScope(path: string): boolean {
  return path.startsWith("docs/contracts/") ||
    (/^(src|crates|scripts|apps|packages|website)\//.test(path) && sourceExtensions.has(extname(path)));
}
function paths(output: string): string[] { return output.split("\0").filter(Boolean); }

async function main() {
  const bash = findBash();
  console.log(`[phase] Bun ${Bun.version}; Bash ${bash}`);
  const sourceFiles = [...new Set(paths(capture(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"])))].filter(inScope).sort();
  let nulChecked = 0;
  for (const path of sourceFiles) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) continue; // Deleted tracked file.
    if (readFileSync(absolute).includes(0)) throw new Error(`${path}: actual NUL byte in source/contract`);
    nulChecked++;
  }
  console.log(`[phase] ${nulChecked} source/contract files checked for actual NUL (no user-data scan)`);

  const changed = paths(capture(["git", "diff", "HEAD", "--name-only", "-z", "--diff-filter=ACMR"]));
  const untracked = paths(capture(["git", "ls-files", "--others", "--exclude-standard", "-z"]));
  const tsFiles = [...new Set([...phaseTypescript, ...changed, ...untracked].filter(path =>
    inScope(path) && /\.(?:ts|tsx|mts|cts)$/.test(path) && existsSync(resolve(root, path)),
  ))].sort();
  for (const path of tsFiles) {
    try {
      new Bun.Transpiler({ loader: extname(path) === ".tsx" ? "tsx" : "ts" }).transformSync(readFileSync(resolve(root, path), "utf8"));
    } catch (error) { throw new Error(`${path}: TypeScript syntax check failed`, { cause: error }); }
  }
  console.log(`[phase] ${tsFiles.length} TS/TSX files parsed with Bun.Transpiler (not typechecking)`);
  for (const path of tsFiles) console.log(`  ${path}`);

  const clientPath = "crates/sub2api/src/client.rs";
  const clientSource = readFileSync(resolve(root, clientPath), "utf8");
  const fixtures = [...clientSource.matchAll(/include_str!\(\s*"([^"\n]*docs\/contracts\/fixtures\/[^"\n]+)"\s*\)/g)];
  if (fixtures.length !== 6) throw new Error(`${clientPath}: expected 6 contract include_str! paths, found ${fixtures.length}`);
  const fixtureRoot = resolve(root, "docs/contracts/fixtures");
  const resolvedFixtures = new Set<string>();
  for (const [, relative] of fixtures) {
    const path = resolve(root, dirname(clientPath), relative);
    if (dirname(path) !== fixtureRoot) throw new Error(`${clientPath}: fixture escaped the contract fixture directory`);
    JSON.parse(readFileSync(path, "utf8"));
    resolvedFixtures.add(path);
  }
  if (resolvedFixtures.size !== 6) throw new Error(`${clientPath}: expected 6 distinct contract fixtures`);
  console.log("[phase] 6 Rust include_str! fixture paths resolved and parsed as JSON");

  let blocks = 0;
  for (const path of [".github/workflows/release.yml", ".github/workflows/sync-release.yml"]) {
    blocks += workflowBash(bash, path).checked;
  }
  checkBash(bash, "scripts/bundle.sh", readFileSync(resolve(root, "scripts/bundle.sh"), "utf8"));
  console.log(`[phase] ${blocks} workflow Bash blocks + scripts/bundle.sh passed bash -n; none executed`);

  console.log(`[phase] Running ${testFiles.length} offline Bun test files`);
  const test = Bun.spawn([process.execPath, "test", ...testFiles], {
    cwd: root, env: environment, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const exitCode = await test.exited;
  if (exitCode !== 0) throw new Error(`Offline Bun tests failed (${exitCode})`);
  console.log("[phase] PASS: offline tests and syntax only; no Rust, network, signing, packaging or workflow execution");
}

try { await main(); } catch (error) {
  console.error("[phase] FAIL", error);
  process.exitCode = 1;
}
