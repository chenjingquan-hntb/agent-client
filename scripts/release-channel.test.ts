import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  POINTERS, STATE_FILE, channelPrefix, classifyTag, compareReleaseTags,
  createSyncPlan, sha256, sortReleaseTags, validateDistribution, validateRelease,
  type Distribution, type GitHubRelease, type StableState, type SyncInput,
} from "./release-channel";

const bytes = (text: string) => new TextEncoder().encode(text);
const config: Distribution = {
  bucket: "owned-releases",
  endpoint: "https://storage.example.test",
  downloadBaseUrl: "https://download.example.test/releases/",
  exclusiveWriter: "sync-release-only",
};
const oldTag = "v1.0.0";
const nextTag = "v1.0.1";
const packageName = (tag: string) => `CheapRouter-${tag.slice(1)}.zip`;
const feed = (tag: string, base = config.downloadBaseUrl) => bytes(
  `<?xml version="1.0"?><rss><channel><item><sparkle:shortVersionString>${tag.slice(1)}</sparkle:shortVersionString><enclosure url="${base}${packageName(tag)}" sparkle:version="1000000" sparkle:edSignature="TEST-ONLY" /></item></channel></rss>`,
);
function assets(tag: string, base = config.downloadBaseUrl): Record<string, Uint8Array> {
  return {
    [packageName(tag)]: bytes(`offline fixture ${tag}`),
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
    prerelease: classifyTag(tag).channel === "prerelease",
    assets: Object.entries(files).map(([name, data]) => ({ name, size: data.length })),
  };
}
function stableInput(tag = nextTag): SyncInput {
  const old = assets(oldTag);
  const currentPointers = Object.fromEntries(POINTERS.map((name) => [name, old[name]!]));
  const state: StableState = {
    schema: 1, tag: oldTag, bucket: config.bucket, endpoint: config.endpoint,
    downloadBaseUrl: config.downloadBaseUrl,
    pointers: Object.fromEntries(POINTERS.map((name) => [name, sha256(old[name]!)])),
  };
  const files = assets(tag);
  return {
    tag, release: release(tag, files), distribution: { ...config }, assets: files,
    currentState: state, currentPointers,
    objects: [
      ...Object.entries(old).map(([Path, data]) => ({ Path, Size: data.length, IsDir: false })),
      { Path: STATE_FILE, Size: JSON.stringify(state).length, IsDir: false },
    ],
  };
}
function rcInput(tag = "v1.0.0-cjq.2-rc.1"): SyncInput {
  const files = assets(tag, `${config.downloadBaseUrl}${channelPrefix(tag)}`);
  return { tag, release: release(tag, files), distribution: { ...config }, assets: files, objects: [] };
}
function refreshRelease(input: SyncInput): void {
  input.release = release(input.tag, input.assets);
}

// No HTTP, gh, rclone, signing keys, or updater modules are imported/run here.

describe("native packaging artifact naming contract", () => {
  test.each([
    "FixtureClient-1.0.1.dmg", "FixtureClient-1.0.1.zip", "FixtureClient-1.0.1.md",
    "fixtureclient-1.0.1-x86_64-pc-windows-msvc.zip",
    "fixtureclient-1.0.1-aarch64-pc-windows-msvc.zip",
    "FixtureClient-1.0.1-x86_64-Setup.exe", "FixtureClient-1.0.1-aarch64-Setup.exe",
  ])("sync accepts actual native packaging name %s", (name) => {
    const input = stableInput("v1.0.1");
    input.assets[name] = bytes("TEST-ONLY native artifact");
    refreshRelease(input);
    expect(createSyncPlan(input).immutable).toContain(name);
  });
  test.each([
    "fixtureclient-1.0.1-i686-pc-windows-msvc.zip",
    "fixtureclient-1.0.1-x86_64-pc-windows-gnu.zip",
    "fixtureclient-1.0.1-aarch64-unknown-linux-gnu.zip",
    "fixtureclient-1.0.1-x86_64-pc-windows-msvc.exe",
    "fixtureclient-1.0.0-x86_64-pc-windows-msvc.zip",
    "FixtureClient-1.0.1Xzip",
    "fixtureclient-1.0.1-x86_64-pc-windows-msvcXzip",
  ])("sync refuses unknown platform/version artifact %s", (name) => {
    const input = stableInput("v1.0.1");
    input.assets[name] = bytes("TEST-ONLY unsupported artifact");
    refreshRelease(input);
    expect(() => createSyncPlan(input)).toThrow("Only exact-version artifacts");
  });
});

describe("explicit business classification and total ordering", () => {
  test.each([
    ["v0.0.0", "stable"], ["v1.2.3", "stable"],
    ["v1.2.3-cjq.1", "prerelease"], ["v1.2.3-cjq.12-rc.2", "prerelease"],
  ])("%s is %s", (tag, channel) => expect(classifyTag(tag).channel).toBe(channel));

  test.each([
    "", "1.2.3", "v1.2", "v01.2.3", "v1.2.03", "v1.2.3-rc.1", "v1.2.3-beta.1",
    "v1.2.3-cjq.0", "v1.2.3-cjq.01", "v1.2.3-cjq.1-rc.0", "v1.2.3-cjq.1-rc.01",
    "v1.2.3-cjq.1-rc.1-extra", "v1.2.3+build.1", "v1.2.3-cjq.1+meta", "v1.2.3\n",
    "v1.2.3\r\n", "v1.2.3; touch /tmp/injected", "$(id)", "--help", "v1.2.3/../latest",
    "v1.2.3\ntag=v9.0.0", "v1.2.3`whoami`", " v1.2.3",
  ])("rejects unknown/unsafe tag %j", (tag) => expect(() => classifyTag(tag)).toThrow());

  test("rc.1 -> rc.2 -> formal -> next cjq formal, without mutating input", () => {
    const ordered = ["v1.0.0-cjq.1-rc.1", "v1.0.0-cjq.1-rc.2", "v1.0.0-cjq.1", "v1.0.0-cjq.2-rc.1", "v1.0.0-cjq.2", "v1.0.1"];
    const reversed = [...ordered].reverse();
    expect(sortReleaseTags(reversed)).toEqual(ordered);
    expect(reversed).toEqual([...ordered].reverse());
    for (let i = 1; i < ordered.length; i++) expect(compareReleaseTags(ordered[i - 1]!, ordered[i]!)).toBe(-1);
    expect(compareReleaseTags("v1.0.0-cjq.1", "v1.0.0-cjq.2")).not.toBe(0);
  });

  test("plain is revision 0; numeric comparison includes large counters without precision loss", () => {
    const ordered = ["v1.0.0", "v1.0.0-cjq.1-rc.2", "v1.0.0-cjq.1-rc.10", "v1.0.0-cjq.1", "v1.0.0-cjq.2", "v1.0.0-cjq.10", "v2.0.0", "v10.0.0"];
    expect(sortReleaseTags([...ordered].reverse())).toEqual(ordered);
    expect(compareReleaseTags("v1.0.0-cjq.9007199254740992", "v1.0.0-cjq.9007199254740993")).toBe(-1);
    for (const a of ordered) for (const b of ordered) {
      expect(compareReleaseTags(a, b) + compareReleaseTags(b, a)).toBe(0);
      expect(compareReleaseTags(a, b) === 0).toBe(a === b);
    }
    expect(() => sortReleaseTags(["v1.0.0", "v1.0.0-beta"])).toThrow();
  });
});

describe("GitHub attributes and explicit distribution", () => {
  test("plain releases are stable; cjq and rc tags are prerelease", () => {
    const formal = stableInput();
    const rc = rcInput();
    expect(validateRelease(formal.tag, formal.release).channel).toBe("stable");
    expect(validateRelease(rc.tag, rc.release).channel).toBe("prerelease");
    formal.release.prerelease = true;
    rc.release.prerelease = false;
    expect(() => validateRelease(formal.tag, formal.release)).toThrow("prerelease");
    expect(() => validateRelease(rc.tag, rc.release)).toThrow("prerelease");
  });
  test.each([true, undefined, "false"])("rejects draft=%j, including absent/nonboolean evidence", (draft) => {
    const input = stableInput();
    input.release.draft = draft as boolean;
    expect(() => validateRelease(input.tag, input.release)).toThrow("Draft");
  });
  test("rejects tag mismatch, missing flags, missing assets and unsafe asset names", () => {
    const input = stableInput();
    expect(() => validateRelease(oldTag, input.release)).toThrow("mismatch");
    expect(() => validateRelease(input.tag, { ...input.release, prerelease: undefined } as any)).toThrow();
    expect(() => validateRelease(input.tag, { ...input.release, assets: [] })).toThrow();
    for (const name of ["../latest-windows.txt", "a/b.zip", "$(id).zip", "bad\nname", "--help", "file."]) {
      expect(() => validateRelease(input.tag, { ...input.release, assets: [{ name, size: 1 }] })).toThrow();
    }
    expect(() => validateRelease(input.tag, { ...input.release, assets: [input.release.assets[0]!, input.release.assets[0]!] })).toThrow("Duplicate");
  });
  test("bucket, endpoint, own served URL and exclusive writer cannot be inferred", () => {
    expect(validateDistribution(config)).toEqual(config);
    for (const key of ["bucket", "endpoint", "downloadBaseUrl", "exclusiveWriter"] as const) {
      expect(() => validateDistribution({ ...config, [key]: "" })).toThrow();
    }
    for (const endpoint of ["http://storage.test", "https://user:pass@storage.test", "https://storage.test/path", "https://storage.test/?key=secret", "https://s3.cheaprouter.cc"]) {
      expect(() => validateDistribution({ ...config, endpoint })).toThrow();
    }
    expect(() => validateDistribution({ ...config, downloadBaseUrl: "https://download.test/releases" })).toThrow();
    expect(() => validateDistribution({ ...config, downloadBaseUrl: "https://releases.waku.sh/releases/" })).toThrow("legacy fork host");
    expect(() => validateDistribution({ ...config, bucket: "owned-releases/../stable" })).toThrow();
  });
});

describe("RC namespace is tag-scoped and immutable", () => {
  test("pointer-named assets only go to prerelease/<tag>/, never stable root", () => {
    const input = rcInput();
    const plan = createSyncPlan(input);
    expect(plan.prefix).toBe(`prerelease/${input.tag}/`);
    expect(plan.pointers).toEqual([...POINTERS].sort());
    expect(plan.state).toBeNull();
    expect(plan.previousStateHash).toBeNull();
    for (const name of [...plan.pointers, ...plan.immutable]) expect(`${plan.prefix}${name}`).toStartWith(`prerelease/${input.tag}/`);
  });
  test("RC does not need/read/change stable state", () => {
    const input = rcInput();
    const old = stableInput();
    input.objects = old.objects;
    input.currentState = { deliberately: "invalid; RC must ignore" };
    expect(createSyncPlan(input).state).toBeNull();
  });
  test("any existing/partial RC prefix rejects duplicate upload; different RC allowed", () => {
    const input = rcInput();
    input.objects = [{ Path: `${channelPrefix(input.tag)}orphan.zip`, Size: 1, IsDir: false }];
    expect(() => createSyncPlan(input)).toThrow("prefix already exists");
    input.objects[0]!.Path = "prerelease/v1.0.0-cjq.2-rc.2/other.zip";
    expect(createSyncPlan(input).prefix).toBe(channelPrefix(input.tag));
  });
  test("old root-linked feeds cannot be smuggled into RC", () => {
    const input = rcInput();
    input.assets["appcast.xml"] = feed(input.tag);
    refreshRelease(input);
    expect(() => createSyncPlan(input)).toThrow("channel URL");
  });
  test("RC can sync only versioned artifacts without a mutable feed", () => {
    const input = rcInput();
    for (const pointer of POINTERS) delete input.assets[pointer];
    refreshRelease(input);
    expect(createSyncPlan(input).pointers).toEqual([]);
  });
});

describe("stable monotonic evidence and fail-closed pointer checks", () => {
  test("matching current hashes + strictly newer tag authorize stable root", () => {
    const input = stableInput();
    const plan = createSyncPlan(input);
    expect(plan.prefix).toBe("");
    expect(plan.state?.tag).toBe(nextTag);
    expect(plan.previousStateHash).toBe(sha256(JSON.stringify(input.currentState)));
    for (const name of POINTERS) expect(plan.state!.pointers[name]).toBe(sha256(input.assets[name]!));
    expect(createSyncPlan(stableInput("v1.0.1")).channel).toBe("stable");
  });
  test.each([oldTag, "v0.9.9", "v0.9.8"])("refuses duplicate/rollback %s", (tag) => {
    expect(() => createSyncPlan(stableInput(tag))).toThrow("rollback or duplicate");
  });
  test("bootstrap never inferred from empty/missing evidence", () => {
    const input = stableInput();
    input.objects = [];
    expect(() => createSyncPlan(input)).toThrow("bootstrap");
    input.objects = stableInput().objects;
    delete input.currentState;
    expect(() => createSyncPlan(input)).toThrow("state evidence");
  });
  test("RC state, wrong storage identity and missing inventory refuse", () => {
    const input = stableInput();
    (input.currentState as StableState).tag = "v1.0.0-cjq.1-rc.2";
    expect(() => createSyncPlan(input)).toThrow("RC tag");
    input.currentState = stableInput().currentState;
    (input.currentState as StableState).bucket = "other-releases";
    expect(() => createSyncPlan(input)).toThrow("identity mismatch");
    input.objects = undefined as any;
    expect(() => createSyncPlan(input)).toThrow("inventory");
  });
  test("hash mismatch / partial last write cannot advance stable state", () => {
    const input = stableInput();
    input.currentPointers!["latest-windows.txt"] = bytes("9.0.0\n");
    expect(() => createSyncPlan(input)).toThrow("hash");
    input.currentPointers = {};
    expect(() => createSyncPlan(input)).toThrow("current pointer bytes");
  });
  test("state tag is not sufficient: even a matching hash must carry exact tag evidence", () => {
    const input = stableInput();
    input.currentPointers!["latest-windows.txt"] = bytes("0.9.9\n");
    (input.currentState as StableState).pointers["latest-windows.txt"] = sha256(input.currentPointers!["latest-windows.txt"]!);
    expect(() => createSyncPlan(input)).toThrow("exact release");
  });
  test("untracked/missing remote pointers and omitted existing pointers refuse", () => {
    const input = stableInput();
    delete (input.currentState as StableState).pointers["appcast.xml"];
    expect(() => createSyncPlan(input)).toThrow("inventory");
    input.currentState = stableInput().currentState;
    input.objects = input.objects.filter((object) => object.Path !== "appcast.xml");
    expect(() => createSyncPlan(input)).toThrow("inventory");
    input.objects = stableInput().objects;
    delete input.assets["appcast.xml"];
    refreshRelease(input);
    expect(() => createSyncPlan(input)).toThrow("omit");
  });
  test("any existing exact-version artifact refuses overwrite, even identical bytes", () => {
    const input = stableInput();
    input.objects.push({ Path: packageName(input.tag), Size: input.assets[packageName(input.tag)]!.length, IsDir: false });
    expect(() => createSyncPlan(input)).toThrow("already exists");
  });
  test("asset mismatch, foreign mutable names and wrong package version refuse", () => {
    const input = stableInput();
    input.release.assets[0]!.size++;
    expect(() => createSyncPlan(input)).toThrow("size mismatch");
    refreshRelease(input);
    input.assets["latest.txt"] = bytes("bad");
    refreshRelease(input);
    expect(() => createSyncPlan(input)).toThrow("exact-version");
    delete input.assets["latest.txt"];
    input.assets[packageName(oldTag)] = bytes("old payload");
    refreshRelease(input);
    expect(() => createSyncPlan(input)).toThrow("exact-version");
  });
  test("latest cannot erase cjq suffix or advertise RC/unknown release", () => {
    for (const value of ["1.0.0\n", "1.0.0-cjq.2-rc.1\n", "1.0.0-cjq.2+meta\n"]) {
      const input = stableInput();
      input.assets["latest-windows.txt"] = bytes(value);
      refreshRelease(input);
      expect(() => createSyncPlan(input)).toThrow("exact release");
    }
  });
  test("stable appcast rejects RC, suffix loss, newer entries and missing identities", () => {
    const variants = [
      feed("v1.0.0-cjq.2-rc.1"), feed("v1.0.0"), feed("v1.0.0-cjq.3"),
      bytes('<rss><channel><item><enclosure url="https://example.test/a.zip" /></item></channel></rss>'),
    ];
    for (const variant of variants) {
      const input = stableInput();
      input.assets["appcast.xml"] = variant;
      refreshRelease(input);
      expect(() => createSyncPlan(input)).toThrow();
    }
  });
  test("stable appcast rejects old-source links, external XML, ambiguous versions and missing objects", () => {
    const input = stableInput();
    const valid = new TextDecoder().decode(input.assets["appcast.xml"]);
    const invalid = [
      valid.replace(config.downloadBaseUrl, "https://releases.waku.sh/"),
      `<!DOCTYPE rss SYSTEM "https://example.test/remote">${valid}`,
      valid.replace("<enclosure ", '<enclosure sparkle:shortVersionString="1.0.0" '),
      valid.replace(packageName(input.tag), "missing.zip"),
    ];
    for (const text of invalid) {
      input.assets["appcast.xml"] = bytes(text);
      refreshRelease(input);
      expect(() => createSyncPlan(input)).toThrow();
    }
  });
  test("valid own-source stable history is accepted, RC history is not", () => {
    const input = stableInput();
    const current = new TextDecoder().decode(feed(input.tag));
    const oldItem = new TextDecoder().decode(feed(oldTag)).match(/<item>[\s\S]*<\/item>/)![0];
    input.assets["appcast.xml"] = bytes(current.replace("</channel>", `${oldItem}</channel>`));
    refreshRelease(input);
    expect(createSyncPlan(input).state?.tag).toBe(nextTag);
    const rcItem = new TextDecoder().decode(feed("v1.0.0-cjq.1-rc.1")).match(/<item>[\s\S]*<\/item>/)![0];
    input.assets["appcast.xml"] = bytes(current.replace("</channel>", `${rcItem}</channel>`));
    refreshRelease(input);
    expect(() => createSyncPlan(input)).toThrow("RC is forbidden");
  });
});

const tempRoot = await mkdtemp(join(tmpdir(), "waku-release-channel-test-"));
afterAll(async () => {
  // Explicit containment check before recursively removing only our temp tree.
  if (dirname(resolve(tempRoot)) !== resolve(tmpdir()) || !tempRoot.split(/[\\/]/).at(-1)!.startsWith("waku-release-channel-test-")) throw new Error("Unsafe temp cleanup path");
  await rm(tempRoot, { recursive: true, force: true });
});
async function cli(command: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "release-channel.ts"), ...command], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}
const cliConfig = {
  R2_BUCKET: config.bucket, R2_ENDPOINT: config.endpoint,
  SUB2API_RELEASES_BASE_URL: config.downloadBaseUrl.slice(0, -1),
  RELEASE_DOWNLOAD_BASE_URL: config.downloadBaseUrl,
  RELEASE_CHANNEL_WRITER: config.exclusiveWriter,
};

describe("offline CLI and workflow wiring", () => {
  test("unsafe tag cannot reach GITHUB_OUTPUT or shell; valid cjq output is prerelease", async () => {
    const output = join(tempRoot, "github-output.txt");
    await writeFile(output, "unchanged\n");
    const bad = await cli(["classify"], { ...cliConfig, RELEASE_TAG: "v1.0.0\ntag=$(id)", GITHUB_OUTPUT: output });
    expect(bad.code).toBe(1);
    expect(await readFile(output, "utf8")).toBe("unchanged\n");
    const good = await cli(["classify"], { ...cliConfig, RELEASE_TAG: "v1.0.0-cjq.1", GITHUB_OUTPUT: output });
    expect(good.code).toBe(0);
    expect(await readFile(output, "utf8")).toContain("tag=v1.0.0-cjq.1\nchannel=prerelease\nprefix=prerelease/v1.0.0-cjq.1/\n");
  });
  test("CLI rejects missing/trailing-slash shared base or independently drifting sync base", async () => {
    const output = join(tempRoot, "base-output.txt");
    await writeFile(output, "unchanged\n");
    for (const override of [
      { SUB2API_RELEASES_BASE_URL: "" },
      { SUB2API_RELEASES_BASE_URL: config.downloadBaseUrl },
      { RELEASE_DOWNLOAD_BASE_URL: "https://foreign.example.test/releases/" },
    ]) {
      const result = await cli(["classify"], { ...cliConfig, ...override, RELEASE_TAG: oldTag, GITHUB_OUTPUT: output });
      expect(result.code).toBe(1);
      expect(await readFile(output, "utf8")).toBe("unchanged\n");
    }
  });
  test("published AND manual metadata validation reject draft/channel mismatches", async () => {
    const input = rcInput();
    const releasePath = join(tempRoot, "release.json");
    const eventPath = join(tempRoot, "event.json");
    await writeFile(releasePath, JSON.stringify(input.release));
    await writeFile(eventPath, JSON.stringify({ release: input.release }));
    for (const event of ["release", "workflow_dispatch"]) {
      expect((await cli(["metadata", releasePath, eventPath], { RELEASE_TAG: input.tag, GITHUB_EVENT_NAME: event })).code).toBe(0);
    }
    await writeFile(eventPath, JSON.stringify({ release: { ...input.release, draft: true } }));
    expect((await cli(["metadata", releasePath, eventPath], { RELEASE_TAG: input.tag, GITHUB_EVENT_NAME: "release" })).code).toBe(1);
    await writeFile(releasePath, JSON.stringify({ ...input.release, prerelease: false }));
    for (const event of ["release", "workflow_dispatch"]) {
      expect((await cli(["metadata", releasePath, eventPath], { RELEASE_TAG: input.tag, GITHUB_EVENT_NAME: event })).code).toBe(1);
    }
  });
  test.each(["stable", "prerelease"])("plan CLI produces local %s allowlists/evidence without network", async (channel) => {
    const input = channel === "stable" ? stableInput() : rcInput();
    const dir = join(tempRoot, channel);
    const assetDir = join(dir, "assets");
    const evidenceDir = join(dir, "evidence");
    const outputDir = join(dir, "plan");
    await mkdir(assetDir, { recursive: true });
    await mkdir(evidenceDir, { recursive: true });
    for (const [name, data] of Object.entries(input.assets)) await writeFile(join(assetDir, name), data);
    for (const [name, data] of Object.entries(input.currentPointers ?? {})) await writeFile(join(evidenceDir, name), data);
    if (input.currentState) await writeFile(join(evidenceDir, STATE_FILE), JSON.stringify(input.currentState));
    const releasePath = join(dir, "release.json");
    const objectsPath = join(dir, "objects.json");
    await writeFile(releasePath, JSON.stringify(input.release));
    await writeFile(objectsPath, JSON.stringify(input.objects));
    const result = await cli(["plan", releasePath, assetDir, objectsPath, evidenceDir, outputDir], { ...cliConfig, RELEASE_TAG: input.tag });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(join(outputDir, "plan.json"), "utf8"))).toEqual(createSyncPlan(input));
    expect(await readFile(join(outputDir, "immutable-files.txt"), "utf8")).toBe(`${packageName(input.tag)}\n`);
    expect(await readFile(join(outputDir, "pointer-files.txt"), "utf8")).toBe(`${[...POINTERS].sort().join("\n")}\n`);
  });
  test("workflow parses as YAML and every extracted Bash run block passes bash -n", async () => {
    const workflow = await readFile(join(import.meta.dir, "../.github/workflows/sync-release.yml"), "utf8");
    const parsed = Bun.YAML.parse(workflow) as any;
    expect(parsed.on.release.types).toEqual(["published"]);
    expect(parsed.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(parsed.concurrency["cancel-in-progress"]).toBe(false);
    expect(parsed.jobs.sync.env.RELEASE_TAG).toBe("${{ github.event.release.tag_name || inputs.tag }}");
    expect(parsed.jobs.sync.env.SUB2API_RELEASES_BASE_URL).toBe("${{ vars.SUB2API_RELEASES_BASE_URL }}");
    expect(parsed.jobs.sync.env.RELEASE_DOWNLOAD_BASE_URL).toBe("${{ format('{0}/', vars.SUB2API_RELEASES_BASE_URL) }}");
    expect(workflow).not.toContain("vars.RELEASE_DOWNLOAD_BASE_URL");
    const environment = { ...process.env };
    // Syntax checks must not source a user's noninteractive Bash startup file.
    for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"]) delete environment[name];
    const cwd = resolve(import.meta.dir, "..");
    let bash: string | null;
    if (process.platform === "win32") {
      // PATH may expose WSL's launcher instead of Git for Windows Bash.
      const git = Bun.spawnSync(["git", "--exec-path"], {
        cwd, env: environment, stdout: "pipe", stderr: "pipe",
      });
      if (!git.success) throw new Error(`git --exec-path failed (${git.exitCode}): ${git.stderr.toString()}`);
      const execPath = git.stdout.toString().trim();
      bash = [
        resolve(execPath, "../../../usr/bin/bash.exe"),
        resolve(execPath, "../../bin/bash.exe"),
      ].find(existsSync) ?? null;
      if (!bash) throw new Error("Git for Windows Bash was not found relative to git --exec-path");
    } else {
      bash = Bun.which("bash");
      if (!bash) throw new Error("bash is required on PATH");
    }
    const runSteps = parsed.jobs.sync.steps.filter((step: any) => typeof step.run === "string");
    expect(runSteps.length).toBe(6);
    for (const step of runSteps) {
      expect(step.run).not.toContain("${{");
      // Parse stdin only; never execute the extracted workflow run block.
      const proc = Bun.spawn([bash, "--noprofile", "--norc", "-n"], {
        cwd, env: environment,
        stdin: new Blob([step.run.replace(/\r\n/g, "\n")]),
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
    }
  });
  test("workflow has unconditional gates, literal shell sources, no inherited bucket, RC-only prefix writes", async () => {
    const workflow = await readFile(join(import.meta.dir, "../.github/workflows/sync-release.yml"), "utf8");
    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("bun scripts/release-channel.ts classify");
    expect(workflow).toContain('metadata release.json "$GITHUB_EVENT_PATH"');
    expect(workflow).not.toContain("cheaprouter-releases");
    expect(workflow).not.toContain('${{ steps.release.outputs.tag }}');
    expect(workflow).not.toMatch(/tag="\$\{\{/);
    expect(workflow).toContain('"${destination}/${PREFIX}${pointer}"');
    expect(workflow).toContain('cmp plan/plan.json plan-recheck/plan.json');
    expect(workflow).toContain("--files-from-raw plan/immutable-files.txt");
    expect(workflow).toContain("--immutable");
  });
});
