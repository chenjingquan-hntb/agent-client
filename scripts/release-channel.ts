#!/usr/bin/env bun
/** Offline release-channel policy. This is NOT the client's updater comparator.
 * CLI inputs are local JSON/files; only the workflow performs gh/rclone I/O.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const POINTERS = [
  "appcast.xml",
  "appcast-windows-x86_64.xml",
  "appcast-windows-aarch64.xml",
  "latest-windows.txt",
] as const;
export const STATE_FILE = "release-channel-state.json";
export type Channel = "stable" | "prerelease";
export interface ReleaseTag {
  tag: string;
  version: string;
  channel: Channel;
  core: readonly bigint[];
  revision: bigint;
  rc: bigint | null;
}

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Business grammar, deliberately not generic SemVer. Plain == revision 0.
 * cjq/rc counters start at 1; no leading zeros or build metadata aliases.
 */
export function classifyTag(tag: string): ReleaseTag {
  requireThat(typeof tag === "string" && tag.length <= 200, "Invalid release tag");
  const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-cjq\.([1-9][0-9]*)(?:-rc\.([1-9][0-9]*))?)?$/.exec(tag);
  // JS $ also matches before a terminal newline: require an exact full match.
  requireThat(match && match[0] === tag, "Unknown release tag (fail closed)");
  return {
    tag,
    version: tag.slice(1),
    channel: match[4] ? "prerelease" : "stable",
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    revision: BigInt(match[4] ?? "0"),
    rc: match[5] ? BigInt(match[5]) : null,
  };
}

/** core -> cjq revision -> rc counter -> final. Never discards suffixes. */
export function compareReleaseTags(left: string, right: string): -1 | 0 | 1 {
  const a = classifyTag(left);
  const b = classifyTag(right);
  for (const [x, y] of [...a.core.map((x, i) => [x, b.core[i]!] as const), [a.revision, b.revision]]) {
    if (x! !== y!) return x! < y! ? -1 : 1;
  }
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc < b.rc ? -1 : 1;
}

export function sortReleaseTags(tags: readonly string[]): string[] {
  tags.forEach(classifyTag);
  return [...tags].sort(compareReleaseTags);
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; size: number }[];
}

function releaseEvidence(release: GitHubRelease): string {
  return JSON.stringify({
    tag_name: release.tag_name,
    draft: release.draft,
    prerelease: release.prerelease,
    assets: release.assets
      .map(({ name, size }) => ({ name, size }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}
export function validateRelease(tag: string, release: GitHubRelease): ReleaseTag {
  const parsed = classifyTag(tag);
  requireThat(release && release.tag_name === tag, "GitHub release tag mismatch");
  requireThat(release.draft === false, "Draft or missing draft evidence is forbidden");
  requireThat(release.prerelease === (parsed.channel === "prerelease"), "GitHub prerelease attribute contradicts business channel");
  requireThat(Array.isArray(release.assets) && release.assets.length > 0, "No GitHub release assets/evidence");
  const names = new Set<string>();
  for (const asset of release.assets) {
    requireThat(asset && typeof asset.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) && !asset.name.endsWith("."), "Unsafe GitHub asset name");
    requireThat(!names.has(asset.name), "Duplicate GitHub asset name");
    requireThat(Number.isSafeInteger(asset.size) && asset.size > 0, "Invalid GitHub asset size");
    names.add(asset.name);
  }
  return parsed;
}

export interface Distribution {
  bucket: string;
  endpoint: string;
  downloadBaseUrl: string;
  exclusiveWriter: string;
}

export function validateDistribution(config: Distribution): Distribution {
  requireThat(config && typeof config.bucket === "string" && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket), "R2_BUCKET must be explicitly configured (no fork default)");
  const checkHttps = (value: string, name: string): URL => {
    requireThat(typeof value === "string" && value.length > 0 && value === value.trim(), `${name} must be explicitly configured`);
    const url = new URL(value);
    requireThat(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, `${name} must be an uncredentialed HTTPS URL`);
    requireThat(!/cheaprouter|waku/i.test(url.hostname), `${name} must not use a legacy fork host`);
    return url;
  };
  const endpoint = checkHttps(config.endpoint, "R2 endpoint");
  requireThat(endpoint.pathname === "/", "R2 endpoint must not contain a path");
  const download = checkHttps(config.downloadBaseUrl, "RELEASE_DOWNLOAD_BASE_URL");
  requireThat(download.href === config.downloadBaseUrl && download.pathname.endsWith("/"), "Download base URL must be canonical and end with / ");
  requireThat(config.exclusiveWriter === "sync-release-only", "Exclusive channel writer ownership must be explicitly confirmed");
  return config;
}

export function channelPrefix(tag: string): string {
  return classifyTag(tag).channel === "prerelease" ? `prerelease/${tag}/` : "";
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface RemoteObject { Path: string; Size: number; IsDir: boolean }
export interface StableState {
  schema: 1;
  tag: string;
  bucket: string;
  endpoint: string;
  downloadBaseUrl: string;
  pointers: Record<string, string>;
}
export interface SyncInput {
  tag: string;
  release: GitHubRelease;
  distribution: Distribution;
  assets: Record<string, Uint8Array>;
  objects: RemoteObject[];
  currentState?: unknown;
  currentPointers?: Record<string, Uint8Array>;
}
export interface SyncPlan {
  schema: 1;
  tag: string;
  channel: Channel;
  prefix: string;
  immutable: string[];
  pointers: string[];
  previousStateHash: string | null;
  state: StableState | null;
}

function remotePaths(objects: RemoteObject[]): Set<string> {
  requireThat(Array.isArray(objects), "Missing successful remote inventory evidence");
  const paths = new Set<string>();
  for (const object of objects) {
    requireThat(object && typeof object.Path === "string" && object.Path.length > 0 && object.IsDir === false && Number.isSafeInteger(object.Size) && object.Size >= 0, "Invalid remote inventory evidence");
    requireThat(!paths.has(object.Path), "Duplicate remote inventory path");
    paths.add(object.Path);
  }
  return paths;
}

const pointerName = (name: string) => (POINTERS as readonly string[]).includes(name);
const versionTag = (version: string) => classifyTag(`v${version}`);
function isVersionedAsset(name: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Windows portable zips include the exact Cargo target triple; no arbitrary suffixes.
  return new RegExp(`^[A-Za-z][A-Za-z0-9_-]*-${escaped}(?:(?:-(?:x86_64|aarch64)(?:-Setup)?)?\\.(?:dmg|zip|exe|md|sha256)|-(?:x86_64|aarch64)-pc-windows-msvc\\.zip)$`).test(name);
}

/** Intentionally narrow feed inspection, not a general XML parser. Unsupported
 * XML, ambiguous versions, foreign links, and missing identity all fail closed.
 * Does not verify EdDSA signatures; that belongs to the separate updater gate.
 */
export function validatePointer(
  name: string,
  bytes: Uint8Array,
  tag: string,
  baseUrl: string,
  available: ReadonlySet<string>,
): void {
  const candidate = classifyTag(tag);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (name === "latest-windows.txt") {
    requireThat(text === candidate.version || text === `${candidate.version}\n` || text === `${candidate.version}\r\n`, "latest pointer must identify the exact release");
    return;
  }
  requireThat(pointerName(name), "Unknown mutable pointer");
  requireThat(!/<!|&(?!(?:amp|lt|gt|quot|apos);)/.test(text), "Unsupported appcast XML/entities");
  const items = [...text.matchAll(/<item(?:\s[^<>]*)?>([\s\S]*?)<\/item>/g)];
  requireThat(items.length > 0 && items.length === (text.match(/<item\b/g) ?? []).length && items.length === (text.match(/<\/item>/g) ?? []).length, "Malformed or empty appcast items");
  let sawCandidate = false;
  const seen = new Set<string>();
  for (const [, item] of items) {
    const tags = [...item!.matchAll(/<sparkle:shortVersionString>([^<>]+)<\/sparkle:shortVersionString>/g)].map((m) => m[1]!.trim());
    const attrs = [...item!.matchAll(/\bsparkle:shortVersionString\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    const versions = [...tags, ...attrs];
    requireThat(versions.length > 0 && versions.every((v) => v === versions[0]), "Missing/ambiguous appcast release identity");
    const entry = versionTag(versions[0]!);
    requireThat(!seen.has(entry.tag), "Duplicate appcast version");
    seen.add(entry.tag);
    requireThat(compareReleaseTags(entry.tag, tag) <= 0, "Appcast contains a newer release than its pointer");
    if (candidate.channel === "stable") requireThat(entry.channel === "stable", "RC is forbidden in a stable appcast");
    if (entry.tag === tag) sawCandidate = true;
    const enclosures = [...item!.matchAll(/<enclosure\b([^<>]*)\/?>/g)];
    requireThat(enclosures.length === 1, "Appcast must have one unambiguous enclosure per item");
    const urls = [...enclosures[0]![1]!.matchAll(/\burl\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    requireThat(urls.length === 1 && urls[0]!.startsWith(baseUrl), "Appcast enclosure must use the explicitly configured channel URL");
    const file = urls[0]!.slice(baseUrl.length);
    requireThat(isVersionedAsset(file, entry.version) && available.has(file), "Appcast enclosure does not identify an available versioned asset");
    for (const [, link] of item!.matchAll(/<sparkle:releaseNotesLink>([^<>]+)<\/sparkle:releaseNotesLink>/g)) {
      requireThat(link!.startsWith(baseUrl) && isVersionedAsset(link!.slice(baseUrl.length), entry.version) && available.has(link!.slice(baseUrl.length)), "Release notes must use the own channel URL and an available asset");
    }
  }
  requireThat(sawCandidate, "Appcast does not contain the exact candidate tag");
}

/** All evidence comes from a successful inventory and freshly downloaded bytes,
 * not GitHub's /latest, timestamps, or a caller-supplied previous tag guess.
 */
export function createSyncPlan(input: SyncInput): SyncPlan {
  const candidate = validateRelease(input.tag, input.release);
  const config = validateDistribution(input.distribution);
  const paths = remotePaths(input.objects);
  const names = Object.keys(input.assets).sort();
  requireThat(names.length === input.release.assets.length, "Downloaded assets differ from GitHub metadata");
  for (const asset of input.release.assets) {
    requireThat(Object.hasOwn(input.assets, asset.name) && input.assets[asset.name]!.byteLength === asset.size, "Downloaded asset missing or size mismatch");
  }
  const pointers = names.filter(pointerName);
  const immutable = names.filter((name) => !pointerName(name));
  requireThat(immutable.length > 0, "No immutable versioned artifacts");
  for (const name of immutable) requireThat(isVersionedAsset(name, candidate.version), "Only exact-version artifacts and known pointers may be synced");
  const prefix = channelPrefix(input.tag);
  let previousStateHash: string | null = null;
  if (candidate.channel === "prerelease") {
    requireThat(![...paths].some((path) => path === prefix.slice(0, -1) || path.startsWith(prefix)), "RC prefix already exists: no repeated/partial overwrite");
    // Even appcast/latest-named assets remain below this tag-scoped RC prefix.
  } else {
    requireThat(pointers.length > 0, "A stable sync must include a version pointer");
    requireThat(paths.has(STATE_FILE), "No stable state evidence: audited bootstrap required; refusing to guess");
    const state = input.currentState as StableState | undefined;
    requireThat(state && state.schema === 1 && state.pointers && typeof state.pointers === "object" && !Array.isArray(state.pointers), "Missing/invalid stable state evidence");
    requireThat(classifyTag(state.tag).channel === "stable", "Stable state has an RC tag");
    requireThat(state.bucket === config.bucket && state.endpoint === config.endpoint && state.downloadBaseUrl === config.downloadBaseUrl, "Stable state distribution identity mismatch");
    requireThat(compareReleaseTags(input.tag, state.tag) > 0, "Stable rollback or duplicate release is forbidden");
    const currentNames = Object.keys(state.pointers).sort();
    const observed = POINTERS.filter((name) => paths.has(name)).sort();
    requireThat(currentNames.length > 0 && JSON.stringify(currentNames) === JSON.stringify(observed), "Stable pointer inventory does not match state");
    requireThat(JSON.stringify(Object.keys(input.currentPointers ?? {}).sort()) === JSON.stringify(observed), "Missing current pointer bytes");
    for (const name of currentNames) {
      requireThat(pointerName(name) && /^[a-f0-9]{64}$/.test(state.pointers[name]!), "Unknown pointer/invalid state digest");
      const bytes = input.currentPointers![name]!;
      requireThat(sha256(bytes) === state.pointers[name], "Current pointer hash does not match stable state");
      requireThat(pointers.includes(name), "Stable release cannot omit an existing pointer");
      validatePointer(name, bytes, state.tag, config.downloadBaseUrl, paths);
    }
    previousStateHash = sha256(JSON.stringify(state));
    for (const name of immutable) requireThat(!paths.has(name), "Immutable artifact already exists: refusing overwrite");
  }
  const available = candidate.channel === "stable"
    ? new Set([...paths, ...immutable]) : new Set(immutable);
  for (const name of pointers) validatePointer(name, input.assets[name]!, input.tag, `${config.downloadBaseUrl}${prefix}`, available);
  const state: StableState | null = candidate.channel === "stable" ? {
    schema: 1,
    tag: input.tag,
    bucket: config.bucket,
    endpoint: config.endpoint,
    downloadBaseUrl: config.downloadBaseUrl,
    pointers: Object.fromEntries(pointers.map((name) => [name, sha256(input.assets[name]!)])),
  } : null;
  return { schema: 1, tag: input.tag, channel: candidate.channel, prefix, immutable, pointers, previousStateHash, state };
}

function environmentDistribution(): Distribution {
  const sharedBase = process.env.SUB2API_RELEASES_BASE_URL ?? "";
  requireThat(sharedBase && sharedBase === sharedBase.trim() && !sharedBase.endsWith("/"), "SUB2API_RELEASES_BASE_URL must be explicitly configured without a trailing / ");
  requireThat(process.env.RELEASE_DOWNLOAD_BASE_URL === `${sharedBase}/`, "Sync download URL must match shared SUB2API_RELEASES_BASE_URL exactly");
  return {
    bucket: process.env.R2_BUCKET ?? "",
    endpoint: process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ""),
    downloadBaseUrl: process.env.RELEASE_DOWNLOAD_BASE_URL ?? "",
    exclusiveWriter: process.env.RELEASE_CHANNEL_WRITER ?? "",
  };
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function readAssets(dir: string): Promise<Record<string, Uint8Array>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: Record<string, Uint8Array> = Object.create(null);
  for (const entry of entries) {
    requireThat(entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name), "Assets must be flat regular files (no symlinks)");
    result[entry.name] = await readFile(join(dir, entry.name));
  }
  return result;
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  const tag = process.env.RELEASE_TAG ?? "";
  if (command === "classify" && args.length === 0) {
    const parsed = classifyTag(tag);
    validateDistribution(environmentDistribution());
    requireThat(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
    await appendFile(process.env.GITHUB_OUTPUT, `tag=${tag}\nchannel=${parsed.channel}\nprefix=${channelPrefix(tag)}\n`);
  } else if (command === "metadata" && args.length === 2) {
    const release = await readJson(args[0]!);
    validateRelease(tag, release);
    if (process.env.GITHUB_EVENT_NAME === "release") {
      const eventRelease = (await readJson(args[1]!)).release;
      validateRelease(tag, eventRelease);
      requireThat(
        releaseEvidence(release) === releaseEvidence(eventRelease),
        "GitHub release payloads disagree",
      );
    } else {
      requireThat(process.env.GITHUB_EVENT_NAME === "workflow_dispatch", "Unsupported sync event");
    }
  } else if (command === "plan" && args.length === 5) {
    const [releasePath, assetDir, objectsPath, evidenceDir, outputDir] = args as [string, string, string, string, string];
    const objects: RemoteObject[] = await readJson(objectsPath);
    const paths = remotePaths(objects);
    const currentPointers: Record<string, Uint8Array> = Object.create(null);
    const stable = classifyTag(tag).channel === "stable";
    if (stable) for (const name of POINTERS) if (paths.has(name)) currentPointers[name] = await readFile(join(evidenceDir, name));
    const plan = createSyncPlan({
      tag,
      release: await readJson(releasePath),
      distribution: environmentDistribution(),
      assets: await readAssets(assetDir),
      objects,
      currentState: stable && paths.has(STATE_FILE) ? await readJson(join(evidenceDir, STATE_FILE)) : undefined,
      currentPointers,
    });
    await mkdir(outputDir);
    await writeFile(join(outputDir, "immutable-files.txt"), `${plan.immutable.join("\n")}\n`);
    await writeFile(join(outputDir, "pointer-files.txt"), plan.pointers.length ? `${plan.pointers.join("\n")}\n` : "");
    if (plan.state) await writeFile(join(outputDir, STATE_FILE), `${JSON.stringify(plan.state, null, 2)}\n`);
    const temporaryPlanPath = join(outputDir, ".plan.json.tmp");
    await writeFile(temporaryPlanPath, `${JSON.stringify(plan, null, 2)}\n`);
    await rename(temporaryPlanPath, join(outputDir, "plan.json"));
    console.log(`Validated ${plan.channel} sync: ${tag} -> ${plan.prefix || "stable root"}`);
  } else {
    throw new Error("Usage: release-channel.ts classify | metadata <release.json> <event.json> | plan <release.json> <assets> <objects.json> <evidence> <output>; tag/config supplied via environment");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    // Do not reflect untrusted tag/asset/config strings into workflow commands.
    console.error(`Release channel gate refused: ${error instanceof Error ? error.message : "invalid input"}`);
    process.exitCode = 1;
  });
}
