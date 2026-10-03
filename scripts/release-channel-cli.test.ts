import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { POINTERS, STATE_FILE, channelPrefix, sha256, type Distribution, type GitHubRelease, type StableState } from "./release-channel";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const config: Distribution = {
  bucket: "owned-releases",
  endpoint: "https://storage.example.test",
  downloadBaseUrl: "https://download.example.test/releases/",
  exclusiveWriter: "sync-release-only",
};
const oldTag = "v1.0.0";
const stableTag = "v1.0.1";
const rcTag = "v1.0.1-cjq.2-rc.1";
const packageName = (tag: string) => `CheapRouter-${tag.slice(1)}.zip`;
const allOutputNames = ["plan.json", "immutable-files.txt", "pointer-files.txt", STATE_FILE] as const;
const syntheticMarker = "SYNTHETIC_RELEASE_PAYLOAD_MARKER";
const scriptPath = resolve(import.meta.dir, "release-channel.ts");
const casePrefix = "waku release cli case ";

const baseEnv: Record<string, string> = {
  R2_BUCKET: config.bucket,
  R2_ENDPOINT: config.endpoint,
  SUB2API_RELEASES_BASE_URL: config.downloadBaseUrl.slice(0, -1),
  RELEASE_DOWNLOAD_BASE_URL: config.downloadBaseUrl,
  RELEASE_CHANNEL_WRITER: config.exclusiveWriter,
};
const allowedEnvironment = new Set([
  "R2_BUCKET",
  "R2_ENDPOINT",
  "R2_ACCOUNT_ID",
  "SUB2API_RELEASES_BASE_URL",
  "RELEASE_DOWNLOAD_BASE_URL",
  "RELEASE_CHANNEL_WRITER",
  "RELEASE_TAG",
  "GITHUB_OUTPUT",
  "GITHUB_EVENT_NAME",
]);

function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const result: Record<string, string> = { ...baseEnv, ...overrides };
  for (const key of Object.keys(result)) {
    if (!allowedEnvironment.has(key) || result[key] === undefined) delete result[key];
  }
  return result;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit = 16 * 1024): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let overflowed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && kept < limit) {
        const take = value.byteLength > limit - kept ? value.subarray(0, limit - kept) : value;
        chunks.push(take.slice());
        kept += take.byteLength;
        if (take.byteLength < value.byteLength) overflowed = true;
      } else if (value) {
        overflowed = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output) + (overflowed ? "\n[bounded output truncated]" : "");
}

async function runCli(root: string, argv: string[], childEnv: Record<string, string>, timeoutMs = 2_000): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, scriptPath, ...argv], {
    cwd: root,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  const exitPromise = proc.exited.then((code) => {
    exited = true;
    return code;
  });
  const stdoutPromise = readBounded(proc.stdout);
  const stderrPromise = readBounded(proc.stderr);
  let timedOut = false;
  let code = 1;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!exited) {
      try {
        proc.kill();
      } catch {
        // The process may have exited between the check and kill.
      }
    }
  }, timeoutMs);
  try {
    code = await exitPromise;
  } finally {
    clearTimeout(timer);
    if (!exited) {
      try {
        proc.kill();
      } catch {
        // Reap below; kill is best effort after a timeout.
      }
    }
    await exitPromise;
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { code: timedOut ? 124 : code, stdout, stderr, timedOut };
}

async function assertOwnedTemp(root: string): Promise<void> {
  const absolute = resolve(root);
  const parent = resolve(tmpdir());
  const entry = await lstat(absolute);
  if (dirname(absolute) !== parent || !basename(absolute).startsWith(casePrefix) || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Refusing unsafe temporary cleanup path: ${absolute}`);
  }
}

async function withCase<T>(name: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `${casePrefix}${name.replace(/[^A-Za-z0-9_-]/g, "-")} `));
  try {
    return await body(root);
  } finally {
    await assertOwnedTemp(root);
    await rm(root, { recursive: true, force: true });
  }
}

function feed(tag: string, base = config.downloadBaseUrl): Uint8Array {
  return bytes(
    `<?xml version="1.0"?><rss><channel><item><sparkle:shortVersionString>${tag.slice(1)}</sparkle:shortVersionString><enclosure url="${base}${packageName(tag)}" sparkle:version="1000000" sparkle:edSignature="SYNTHETIC-ONLY" /></item></channel></rss>`,
  );
}

function assets(tag: string, base = config.downloadBaseUrl): Record<string, Uint8Array> {
  return {
    [packageName(tag)]: bytes(`synthetic artifact ${tag}`),
    "appcast.xml": feed(tag, base),
    "appcast-windows-x86_64.xml": feed(tag, base),
    "appcast-windows-aarch64.xml": feed(tag, base),
    "latest-windows.txt": bytes(`${tag.slice(1)}\n`),
  };
}

function release(tag: string, files: Record<string, Uint8Array>): GitHubRelease {
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-cjq.") ,
    assets: Object.entries(files).map(([name, data]) => ({ name, size: data.byteLength })),
  };
}

function stableFixture() {
  const previous = assets(oldTag);
  const files = assets(stableTag);
  const state: StableState = {
    schema: 1,
    tag: oldTag,
    bucket: config.bucket,
    endpoint: config.endpoint,
    downloadBaseUrl: config.downloadBaseUrl,
    pointers: Object.fromEntries(POINTERS.map((name) => [name, sha256(previous[name]!)])),
  };
  return {
    tag: stableTag,
    files,
    release: release(stableTag, files),
    objects: [
      ...Object.entries(previous).map(([Path, data]) => ({ Path, Size: data.byteLength, IsDir: false })),
      { Path: STATE_FILE, Size: JSON.stringify(state).length, IsDir: false },
    ],
    state,
    currentPointers: previous,
  };
}

function rcFixture() {
  const files = assets(rcTag, `${config.downloadBaseUrl}${channelPrefix(rcTag)}`);
  return {
    tag: rcTag,
    files,
    release: release(rcTag, files),
    objects: [] as { Path: string; Size: number; IsDir: boolean }[],
    state: undefined,
    currentPointers: {},
  };
}

async function writePlanFixture(root: string, fixture: ReturnType<typeof stableFixture> | ReturnType<typeof rcFixture>) {
  const assetDir = join(root, "synthetic assets");
  const evidenceDir = join(root, "synthetic evidence");
  const outputDir = join(root, "synthetic plan output");
  await mkdir(assetDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  for (const [name, data] of Object.entries(fixture.files)) await writeFile(join(assetDir, name), data);
  for (const [name, data] of Object.entries(fixture.currentPointers)) await writeFile(join(evidenceDir, name), data);
  if (fixture.state) await writeFile(join(evidenceDir, STATE_FILE), `${JSON.stringify(fixture.state)}\n`);
  const releasePath = join(root, "synthetic release.json");
  const objectsPath = join(root, "synthetic objects.json");
  await writeFile(releasePath, `${JSON.stringify(fixture.release)}\n`);
  await writeFile(objectsPath, `${JSON.stringify(fixture.objects)}\n`);
  return { assetDir, evidenceDir, outputDir, releasePath, objectsPath };
}

function expectFailure(result: CliResult): void {
  expect(result.code).not.toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toBe("");
}

async function expectNoPlan(outputDir: string): Promise<void> {
  expect(existsSync(join(outputDir, "plan.json"))).toBe(false);
}

const tempRoots: string[] = [];
afterAll(async () => {
  // This suite uses per-case cleanup; retain this guard to catch an accidental helper leak.
  for (const root of tempRoots) {
    await assertOwnedTemp(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("M-005 offline release-channel CLI boundary", () => {
  test("classify emits exact ordinary, cjq, and RC output", async () => {
    await withCase("classify-exact", async (root) => {
      for (const tag of ["v1.2.3", "v1.2.3-cjq.4", "v1.2.3-cjq.4-rc.2"]) {
        const output = join(root, `${tag}-github-output.txt`);
        await writeFile(output, "seed\n");
        const result = await runCli(root, ["classify"], env({ RELEASE_TAG: tag, GITHUB_OUTPUT: output }));
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("");
        const channel = tag.includes("-cjq.") ? "prerelease" : "stable";
        const prefix = channel === "prerelease" ? `prerelease/${tag}/` : "";
        expect(await readFile(output, "utf8")).toBe(`seed\ntag=${tag}\nchannel=${channel}\nprefix=${prefix}\n`);
      }
    });
  });

  test("classify rejects missing environment, invalid tags, and legacy sources without output", async () => {
    await withCase("classify-failures", async (root) => {
      const cases: Array<{ name: string; childEnv: Record<string, string>; output: string }> = [];
      const missingBucket = join(root, "missing-bucket-output.txt");
      const invalidTag = join(root, "invalid-tag-output.txt");
      const legacySource = join(root, "legacy-source-output.txt");
      for (const output of [missingBucket, invalidTag, legacySource]) await writeFile(output, "unchanged\n");
      cases.push({ name: "missing env", childEnv: env({ RELEASE_TAG: oldTag, GITHUB_OUTPUT: missingBucket, R2_BUCKET: undefined }), output: missingBucket });
      cases.push({ name: "invalid tag", childEnv: env({ RELEASE_TAG: "v1.2.3\ntag=$(id)", GITHUB_OUTPUT: invalidTag }), output: invalidTag });
      cases.push({
        name: "legacy source",
        childEnv: env({
          RELEASE_TAG: oldTag,
          GITHUB_OUTPUT: legacySource,
          SUB2API_RELEASES_BASE_URL: "https://cheaprouter.example.test/releases",
          RELEASE_DOWNLOAD_BASE_URL: "https://cheaprouter.example.test/releases/",
        }),
        output: legacySource,
      });
      for (const item of cases) {
        const result = await runCli(root, ["classify"], item.childEnv);
        expectFailure(result);
        expect(await readFile(item.output, "utf8")).toBe("unchanged\n");
      }
    });
  });

  test("metadata accepts published and manual synthetic payloads", async () => {
    await withCase("metadata-success", async (root) => {
      const fixture = rcFixture();
      const releasePath = join(root, "release.json");
      const eventPath = join(root, "event.json");
      await writeFile(releasePath, JSON.stringify(fixture.release));
      await writeFile(eventPath, JSON.stringify({ release: fixture.release }));
      const published = await runCli(root, ["metadata", releasePath, eventPath], env({ RELEASE_TAG: fixture.tag, GITHUB_EVENT_NAME: "release" }));
      expect(published.code).toBe(0);
      expect(published.stdout).toBe("");
      const manual = await runCli(root, ["metadata", releasePath, eventPath], env({ RELEASE_TAG: fixture.tag, GITHUB_EVENT_NAME: "workflow_dispatch" }));
      expect(manual.code).toBe(0);
      expect(manual.stdout).toBe("");
    });
  });

  test("metadata rejects draft/channel/tag/malformed/missing and inconsistent payloads without echoing synthetic data", async () => {
    await withCase("metadata-failures", async (root) => {
      const fixture = rcFixture();
      const releasePath = join(root, "release.json");
      const eventPath = join(root, "event.json");
      await writeFile(releasePath, JSON.stringify(fixture.release));
      await writeFile(eventPath, JSON.stringify({ release: fixture.release }));
      const runMetadata = async (eventName = "release") => runCli(root, ["metadata", releasePath, eventPath], env({ RELEASE_TAG: fixture.tag, GITHUB_EVENT_NAME: eventName }));
      const assertNoMarker = (result: CliResult) => {
        expectFailure(result);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(syntheticMarker);
      };

      await writeFile(releasePath, JSON.stringify({ ...fixture.release, draft: true }));
      assertNoMarker(await runMetadata());
      await writeFile(releasePath, JSON.stringify({ ...fixture.release, prerelease: false }));
      assertNoMarker(await runMetadata());
      await writeFile(releasePath, JSON.stringify({ ...fixture.release, tag_name: oldTag }));
      assertNoMarker(await runMetadata());
      await writeFile(releasePath, `{ "tag_name": "${syntheticMarker}`);
      assertNoMarker(await runMetadata());
      await rm(releasePath);
      assertNoMarker(await runMetadata());

      await writeFile(releasePath, JSON.stringify(fixture.release));
      await rm(eventPath);
      assertNoMarker(await runMetadata());

      await writeFile(eventPath, JSON.stringify({ release: { ...fixture.release, assets: [{ name: packageName(fixture.tag), size: 999999 }] } }));
      assertNoMarker(await runMetadata());

      await writeFile(eventPath, JSON.stringify({ release: { ...fixture.release, assets: [{ name: packageName(fixture.tag), size: fixture.files[packageName(fixture.tag)]!.byteLength }] } }));
      assertNoMarker(await runMetadata());

      await writeFile(eventPath, JSON.stringify({ release: fixture.release }));
      const validAgain = await runMetadata();
      expect(validAgain.code).toBe(0);
    });
  });

  test.each([
    ["stable", stableFixture],
    ["RC", rcFixture],
  ] as const)("plan creates %s synthetic plan/list/state files with expected paths", async (label, makeFixture) => {
    await withCase(`plan-${label}`, async (root) => {
      const fixture = makeFixture();
      const paths = await writePlanFixture(root, fixture);
      const result = await runCli(root, ["plan", paths.releasePath, paths.assetDir, paths.objectsPath, paths.evidenceDir, paths.outputDir], env({ RELEASE_TAG: fixture.tag }));
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`Validated ${label === "RC" ? "prerelease" : "stable"} sync: ${fixture.tag} -> ${label === "RC" ? `prerelease/${fixture.tag}/` : "stable root"}\n`);
      const plan = JSON.parse(await readFile(join(paths.outputDir, "plan.json"), "utf8"));
      expect(plan).toMatchObject({
        schema: 1,
        tag: fixture.tag,
        channel: label === "RC" ? "prerelease" : "stable",
        prefix: label === "RC" ? `prerelease/${fixture.tag}/` : "",
        immutable: [packageName(fixture.tag)],
        pointers: [...POINTERS].sort(),
      });
      expect(await readFile(join(paths.outputDir, "immutable-files.txt"), "utf8")).toBe(`${packageName(fixture.tag)}\n`);
      expect(await readFile(join(paths.outputDir, "pointer-files.txt"), "utf8")).toBe(`${[...POINTERS].sort().join("\n")}\n`);
      if (label === "stable") {
        const state = JSON.parse(await readFile(join(paths.outputDir, STATE_FILE), "utf8"));
        expect(state).toMatchObject({ schema: 1, tag: fixture.tag, bucket: config.bucket, endpoint: config.endpoint, downloadBaseUrl: config.downloadBaseUrl });
        expect(Object.keys(state.pointers).sort()).toEqual([...POINTERS].sort());
      } else {
        expect(existsSync(join(paths.outputDir, STATE_FILE))).toBe(false);
      }
    });
  });

  test.each([
    "immutable collision",
    "state pointer mismatch",
    "missing evidence",
    "illegal asset",
    "asset subdirectory",
    "downloaded metadata mismatch",
  ])("plan rejects %s with no usable fresh plan", async (failure) => {
    await withCase(`plan-${failure}`, async (root) => {
      const fixture = stableFixture();
      const paths = await writePlanFixture(root, fixture);
      if (failure === "immutable collision") {
        fixture.objects.push({ Path: packageName(fixture.tag), Size: fixture.files[packageName(fixture.tag)]!.byteLength, IsDir: false });
        await writeFile(paths.objectsPath, JSON.stringify(fixture.objects));
      } else if (failure === "state pointer mismatch") {
        await writeFile(join(paths.evidenceDir, "appcast.xml"), bytes("pointer mismatch"));
      } else if (failure === "missing evidence") {
        await rm(join(paths.evidenceDir, STATE_FILE));
      } else if (failure === "illegal asset") {
        await writeFile(join(paths.assetDir, "unsafe asset.txt"), bytes("invalid synthetic asset"));
      } else if (failure === "asset subdirectory") {
        await mkdir(join(paths.assetDir, "nested directory"));
      } else if (failure === "downloaded metadata mismatch") {
        await writeFile(join(paths.assetDir, packageName(fixture.tag)), bytes("different downloaded bytes"));
      }
      const result = await runCli(root, ["plan", paths.releasePath, paths.assetDir, paths.objectsPath, paths.evidenceDir, paths.outputDir], env({ RELEASE_TAG: fixture.tag }));
      expectFailure(result);
      await expectNoPlan(paths.outputDir);
    });
  });

  test("reused output refuses to write and preserves every existing user file", async () => {
    await withCase("plan-output-reuse", async (root) => {
      const fixture = stableFixture();
      const paths = await writePlanFixture(root, fixture);
      await mkdir(paths.outputDir, { recursive: true });
      const priorPlan = `prior plan ${syntheticMarker}\n`;
      const priorImmutable = "prior-immutable\n";
      const priorState = "prior state\n";
      await writeFile(join(paths.outputDir, "plan.json"), priorPlan);
      await writeFile(join(paths.outputDir, "immutable-files.txt"), priorImmutable);
      await writeFile(join(paths.outputDir, STATE_FILE), priorState);
      await mkdir(join(paths.outputDir, "pointer-files.txt"));
      const result = await runCli(root, ["plan", paths.releasePath, paths.assetDir, paths.objectsPath, paths.evidenceDir, paths.outputDir], env({ RELEASE_TAG: fixture.tag }));
      expectFailure(result);
      expect(await readFile(join(paths.outputDir, "plan.json"), "utf8")).toBe(priorPlan);
      expect(await readFile(join(paths.outputDir, "immutable-files.txt"), "utf8")).toBe(priorImmutable);
      expect(await readFile(join(paths.outputDir, STATE_FILE), "utf8")).toBe(priorState);
      expect((await lstat(join(paths.outputDir, "pointer-files.txt"))).isDirectory()).toBe(true);
    });
  });

  test("a fresh output write obstruction leaves no successful plan marker", async () => {
    await withCase("plan-fresh-write-failure", async (root) => {
      const fixture = stableFixture();
      const paths = await writePlanFixture(root, fixture);
      await rm(paths.outputDir, { recursive: true, force: true });
      const outputPathFile = join(root, "synthetic plan output");
      await writeFile(outputPathFile, "not a directory\n");
      const result = await runCli(root, ["plan", paths.releasePath, paths.assetDir, paths.objectsPath, paths.evidenceDir, outputPathFile], env({ RELEASE_TAG: fixture.tag }));
      expectFailure(result);
      expect(await readFile(outputPathFile, "utf8")).toBe("not a directory\n");
      await expectNoPlan(outputPathFile);
    });
  });

  test("asset symlink is rejected when the platform permits synthetic symlink creation", async () => {
    await withCase("plan-symlink", async (root) => {
      const fixture = stableFixture();
      const paths = await writePlanFixture(root, fixture);
      const assetPath = join(paths.assetDir, packageName(fixture.tag));
      const target = join(root, "symlink target.bin");
      await writeFile(target, await readFile(assetPath));
      await rm(assetPath);
      try {
        await symlink(target, assetPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          console.warn(`[SKIP] symlink boundary unavailable on this platform (${code})`);
          return;
        }
        throw error;
      }
      const result = await runCli(root, ["plan", paths.releasePath, paths.assetDir, paths.objectsPath, paths.evidenceDir, paths.outputDir], env({ RELEASE_TAG: fixture.tag }));
      expectFailure(result);
      await expectNoPlan(paths.outputDir);
    });
  });

  test("the child uses an isolated space-containing cwd and never needs shell/network tools", async () => {
    await withCase("cwd-and-env-isolation", async (root) => {
      const outputName = "relative github output.txt";
      const result = await runCli(root, ["classify"], env({ RELEASE_TAG: "v2.0.0-cjq.7-rc.3", GITHUB_OUTPUT: outputName }));
      expect(result.code).toBe(0);
      expect(await readFile(join(root, outputName), "utf8")).toBe(
        "tag=v2.0.0-cjq.7-rc.3\nchannel=prerelease\nprefix=prerelease/v2.0.0-cjq.7-rc.3/\n",
      );
    });
  });
});
