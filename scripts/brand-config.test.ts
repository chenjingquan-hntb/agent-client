import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertSiteEnclosureUrl, assertStableClientVersion, brandEnvNames, cargoReleaseVersion,
  legacyPublicKey, legacyWindowsAppId, releaseDownloadPrefix, resolveBrandConfig,
  validatePublicKey, type BrandEnvironment,
} from "./brand-config.ts";
import { appPublicKey, compareVersions, renderAppcast } from "./appcast-windows.ts";

// Synthetic PUBLIC bytes only, not a generated key or any production identity.
const publicFixture = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("base64");
const fixture = (): BrandEnvironment => ({
  SUB2API_SITE_RELEASE: "1", SUB2API_BRAND_NAME: "FixtureClient",
  SUB2API_BRAND_BUNDLE_ID: "test.fixture.client", SUB2API_BRAND_WEBSITE: "https://www.fixture.test",
  SUB2API_MANAGED_SERVICE_URL: "https://api.fixture.test",
  SUB2API_RELEASES_BASE_URL: "https://updates.fixture.test/client",
  SUB2API_DATA_DIR_NAME: ".fixture-client", SUB2API_PLATFORM_DATA_DIR_NAME: "Fixture Client Data",
  SUB2API_WINDOWS_APP_ID: "12345678-1234-1234-1234-123456789ABC",
  SUB2API_PUBLISHER: "Fixture Publisher", SUB2API_SPARKLE_PUBLIC_KEY: publicFixture,
});
const source = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const saved = new Map<string, string | undefined>();
function useEnv(env: BrandEnvironment) {
  for (const name of ["SUB2API_SITE_RELEASE", ...Object.values(brandEnvNames), "WAKU_DOWNLOAD_URL_PREFIX", "SUB2API_MANAGED_SERVICE_ALT_URLS"]) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
}
afterEach(() => {
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
});

describe("explicit release opt-in", () => {
  test("development defaults and partial overrides remain compatible", () => {
    const config = resolveBrandConfig({});
    expect(config.siteRelease).toBe(false); expect(config.name).toBe("CheapRouter");
    expect(config.bundleId).toBe("sh.waku"); expect(config.publicKey).toBeUndefined();
    expect(resolveBrandConfig({ SUB2API_BRAND_NAME: "Local" }).name).toBe("Local");
    expect(releaseDownloadPrefix({ WAKU_DOWNLOAD_URL_PREFIX: "http://localhost:3000/" })).toBe("http://localhost:3000/");
  });
  test("CI cannot silently use defaults", () => expect(() => resolveBrandConfig({}, { requireSite: true })).toThrow("SUB2API_SITE_RELEASE=1"));
  for (const flag of ["true", "yes", " 1", "2"]) test("invalid opt-in: " + flag, () => expect(() => resolveBrandConfig({ SUB2API_SITE_RELEASE: flag })).toThrow());
  test("complete confirmed fixture works on both platforms", () => {
    for (const platform of ["windows", "macos", "all"] as const) {
      expect(resolveBrandConfig(fixture(), { platform, version: "0.2.8", requireSite: true }).publicKey).toBe(publicFixture);
    }
    expect(releaseDownloadPrefix(fixture())).toBe("https://updates.fixture.test/client/");
  });
  for (const envName of Object.values(brandEnvNames)) {
    test("required " + envName, () => { const env = fixture(); delete env[envName]; expect(() => resolveBrandConfig(env, { platform: "windows" })).toThrow(envName); });
    test("empty " + envName, () => { const env = fixture(); env[envName] = ""; expect(() => resolveBrandConfig(env)).toThrow(envName); });
    test("whitespace " + envName, () => { const env = fixture(); env[envName] += " "; expect(() => resolveBrandConfig(env)).toThrow(envName); });
  }
  test("mac-only configuration does not invent Windows credentials", () => {
    const env = fixture(); delete env.SUB2API_WINDOWS_APP_ID; delete env.SUB2API_PUBLISHER;
    expect(resolveBrandConfig(env, { platform: "macos" }).publicKey).toBe(publicFixture);
    expect(releaseDownloadPrefix(env, "macos")).toBe("https://updates.fixture.test/client/");
    expect(() => resolveBrandConfig(env, { platform: "windows" })).toThrow();
  });
  test("M004 release env names are exact and debug overrides cannot replace release identity", () => {
    const env=fixture();
    env.SUB2API_BRAND_BUNDLE_ID_DEBUG="sh.waku.dev";
    env.SUB2API_PLATFORM_DATA_DIR_NAME_DEBUG="Waku Debug";
    const config=resolveBrandConfig(env);
    expect(config.bundleId).toBe("test.fixture.client");
    expect(config.platformDataName).toBe("Fixture Client Data");
    delete env.SUB2API_PLATFORM_DATA_DIR_NAME;
    env.SUB2API_PLATFORM_DATA_NAME="Fixture Client Data";
    expect(() => resolveBrandConfig(env)).toThrow("SUB2API_PLATFORM_DATA_DIR_NAME");
  });
  test("custom Linux and unknown platforms fail", () => {
    expect(() => resolveBrandConfig(fixture(), { platform: "linux" })).toThrow("not supported");
    expect(() => resolveBrandConfig(fixture(), { platform: "unknown" as any })).toThrow("Unsupported");
  });
});

describe("own metadata, no inherited identity", () => {
  for (const name of ["Fixture Client", "测试客户端", "Fixture.Client", "1FixtureClient"]) {
    test("site artifact basename rejects " + name, () => {
      expect(() => resolveBrandConfig({ ...fixture(), SUB2API_BRAND_NAME: name })).toThrow("current artifact naming limitation");
    });
  }
  test("site artifact basename accepts ASCII letters, digits, underscores and hyphens", () => {
    expect(resolveBrandConfig({ ...fixture(), SUB2API_BRAND_NAME: "Fixture_Client-2" }).name).toBe("Fixture_Client-2");
  });
  test("publisher and platform directory retain safe Unicode and spaces", () => {
    const config=resolveBrandConfig({ ...fixture(), SUB2API_PUBLISHER: "测试 Publisher", SUB2API_PLATFORM_DATA_DIR_NAME: "客户端 Data" });
    expect(config.publisher).toBe("测试 Publisher");
    expect(config.platformDataName).toBe("客户端 Data");
  });
  test("development product names remain unrestricted by site artifact naming", () => {
    expect(resolveBrandConfig({ SUB2API_BRAND_NAME: "测试 Client" }).name).toBe("测试 Client");
  });

  const bad: [string, string][] = [
    ["SUB2API_BRAND_NAME", "CheapRouter"], ["SUB2API_BRAND_NAME", "Waku Debug"],
    ["SUB2API_BRAND_NAME", "../Client"], ["SUB2API_BRAND_NAME", 'Client"'],
    ["SUB2API_BRAND_NAME", "Client{app}"], ["SUB2API_BRAND_NAME", "CON"],
    ["SUB2API_BRAND_BUNDLE_ID", "sh.waku"], ["SUB2API_BRAND_BUNDLE_ID", "org.cheaprouter.desktop"],
    ["SUB2API_BRAND_BUNDLE_ID", "client"], ["SUB2API_DATA_DIR_NAME", ".waku"],
    ["SUB2API_DATA_DIR_NAME", ".cheaprouter"], ["SUB2API_DATA_DIR_NAME", "../data"],
    ["SUB2API_PLATFORM_DATA_DIR_NAME", "CheapRouter"], ["SUB2API_PLATFORM_DATA_DIR_NAME", "C:\\Data"],
    ["SUB2API_PUBLISHER", "Waku"], ["SUB2API_WINDOWS_APP_ID", legacyWindowsAppId.toLowerCase()],
    ["SUB2API_WINDOWS_APP_ID", "not-a-guid"], ["SUB2API_WINDOWS_APP_ID", "{12345678-1234-1234-1234-123456789ABC}"],
    ["SUB2API_SPARKLE_PUBLIC_KEY", legacyPublicKey], ["SUB2API_SPARKLE_PUBLIC_KEY", "not-base64"],
  ];
  for (const [name, value] of bad) test(name + " rejects " + value, () => expect(() => resolveBrandConfig({ ...fixture(), [name]: value })).toThrow());
  for (const name of ["SUB2API_BRAND_WEBSITE", "SUB2API_MANAGED_SERVICE_URL", "SUB2API_RELEASES_BASE_URL"]) {
    for (const value of ["https://cheaprouter.cc", "https://s3.cheaprouter.cc/cheaprouter-releases", "https://releases.waku.sh", "https://%63heaprouter.cc", "http://updates.fixture.test", "https://user:password@updates.fixture.test", "https://updates.fixture.test/?query=1", "https://updates.fixture.test/#fragment", "https://updates.fixture.test/", "https://example.com", "https://unset.invalid", "https://updates.fixture.test/../elsewhere", "https://updates.fixture.test/{app}"]) {
      test(name + " rejects " + value, () => expect(() => resolveBrandConfig({ ...fixture(), [name]: value })).toThrow());
    }
  }
  test("managed mirrors cannot retain another fork's host", () => expect(() => resolveBrandConfig({ ...fixture(), SUB2API_MANAGED_SERVICE_ALT_URLS: "https://cheaprouter.cc" })).toThrow());
  test("only public 32-byte canonical base64 accepted", () => {
    expect(validatePublicKey(publicFixture)).toBe(publicFixture);
    for (const key of [Buffer.alloc(32).toString("base64"), Buffer.alloc(64).toString("base64"), publicFixture + "\n", publicFixture.slice(0, -1)]) expect(() => validatePublicKey(key)).toThrow();
  });
});

describe("update source and supported version boundary", () => {
  for (const prefix of ["https://releases.waku.sh/", "https://s3.cheaprouter.cc/cheaprouter-releases/", "https://other.fixture.test/", "https://updates.fixture.test/client", " ", ""]) {
    test("reject download override " + prefix, () => {
      const env = { ...fixture(), WAKU_DOWNLOAD_URL_PREFIX: prefix };
      if (prefix === "") expect(releaseDownloadPrefix(env)).toBe("https://updates.fixture.test/client/");
      else expect(() => releaseDownloadPrefix(env)).toThrow("WAKU_DOWNLOAD_URL_PREFIX");
    });
  }
  test("matching explicit prefix works", () => expect(releaseDownloadPrefix({ ...fixture(), WAKU_DOWNLOAD_URL_PREFIX: "https://updates.fixture.test/client/" })).toBe("https://updates.fixture.test/client/"));
  test("inherited enclosures and deltas cannot escape configured source", () => {
    const prefix = "https://updates.fixture.test/client/";
    assertSiteEnclosureUrl(prefix + "Fixture-0.2.8.zip", prefix);
    for (const url of ["https://releases.waku.sh/Waku.zip", "https://cheaprouter.cc/update.exe", prefix + "../../evil.zip", "https://updates.fixture.test/client-malicious/x.zip", prefix + "x.zip?redirect=https://cheaprouter.cc"]) expect(() => assertSiteEnclosureUrl(url, prefix)).toThrow();
  });
  for (const version of ["0.2.8", "1.0.0", "999.999.999"]) test("plain version " + version, () => assertStableClientVersion(version));
  for (const version of ["1.0.0-cjq.1", "1.0.0-cjq.1-rc.1", "1.0.0-rc.1", "1.0.0+build", "v1.0.0", "01.0.0", "1.2", "1000.0.0", "1.0.0\n"]) test("unsupported " + version, () => {
    expect(() => assertStableClientVersion(version)).toThrow("only plain X.Y.Z");
    expect(() => compareVersions(version, "1.0.0")).toThrow();
  });
  test("Windows comparer cannot silently discard revisions", () => { expect(compareVersions("0.2.8", "0.2.9")).toBeLessThan(0); expect(compareVersions("1.0.0", "1.0.0")).toBe(0); });
  test("Cargo version remains unchanged", () => expect(cargoReleaseVersion()).toBe("0.2.8"));
});

describe("public-key and packaging wiring (offline/static)", () => {
  test("Windows signer takes public key from env before plist fallback", async () => {
    useEnv(fixture()); expect(await appPublicKey()).toBe(publicFixture);
    process.env.SUB2API_SPARKLE_PUBLIC_KEY = legacyPublicKey;
    await expect(appPublicKey()).rejects.toThrow("previous fork");
  });
  test("development still trusts embedded public plist key", async () => {
    useEnv({}); const plist = source("resources/Info.plist");
    const key = plist.split("<key>SUPublicEDKey</key>")[1]?.split("<string>")[1]?.split("</string>")[0]?.trim();
    expect(await appPublicKey()).toBe(key!);
  });
  test("Windows feed title uses configured brand", () => { useEnv(fixture()); expect(renderAppcast("x86_64", [])).toContain("FixtureClient (Windows x86_64)"); });
  test("build/mac/signer use the same public env and release identity", () => {
    const build = source("build.rs"), bundle = source("scripts/bundle.sh"), signer = source("scripts/appcast-windows.ts");
    expect(build).toContain('std::env::var("SUB2API_SPARKLE_PUBLIC_KEY")');
    expect(build).toContain("WAKU_SPARKLE_PUBLIC_ED_KEY");
    expect(build.indexOf('std::env::var("SUB2API_SPARKLE_PUBLIC_KEY")')).toBeLessThan(build.indexOf("std::fs::read_to_string(PLIST)"));
    expect(build).toContain('scripts/brand-config.ts'); expect(build).not.toContain("SPARKLE_PRIVATE_KEY");
    expect(bundle).toContain('plutil -replace SUPublicEDKey -string "$site_public_key"');
    expect(bundle).toContain('plutil -replace SUFeedURL -string "$site_feed_url"');
    expect(bundle).toContain('plutil -replace CFBundleIdentifier -string "$bundle_identifier"');
    expect(signer).toContain("if (brand.publicKey) return brand.publicKey;");
    expect(signer).toContain("if (derived !== expected)");
  });
  test("site direct publication and stale compiled identity cannot bypass exclusive writer", () => {
    const script=source("scripts/release.ts");
    expect(script).toContain("brand.siteRelease && !localOnly");
    expect(script).toContain("sync-release is the exclusive publishing writer");
    expect(script).toContain('brand.siteRelease && values["skip-build"]');
  });
  test("installer consumes branded macros and configured isolation", () => {
    const iss=source("resources/windows/waku.iss"), bundle=source("scripts/bundle-windows.ts");
    for (const macro of ["ProductName", "ProductAppId", "ProductPublisher", "ProductWebsite", "ProductReleasesURL", "ProductDirectory", "ProductMutex"]) { expect(iss).toContain("{#" + macro + "}"); expect(bundle).toContain("/D" + macro + "="); }
    expect(iss).toContain("AppId={{{#ProductAppId}}");
  });
  test("CI preflight precedes build and sources all public metadata via vars", () => {
    const ci=source(".github/workflows/release.yml"); expect(ci.indexOf("--require-site --platform all")).toBeLessThan(ci.indexOf("Install Rust"));
    for (const name of ["SUB2API_SITE_RELEASE", ...Object.values(brandEnvNames)]) expect(ci).toContain("vars." + name);
    expect(ci).not.toContain("releases.waku.sh"); expect(ci).not.toContain("CheapRouter"); expect(ci).not.toContain("cheaprouter");
    expect(ci).toContain('$SUB2API_RELEASES_BASE_URL/appcast-windows-$arch.xml');
  });
  test("write set contains no actual NUL and TS transforms without executing builds", () => {
    const files=["scripts/brand-config.ts", "scripts/brand-config.test.ts", "scripts/bundle-windows.ts", "scripts/bundle.sh", "scripts/release.ts", "scripts/appcast.ts", "scripts/appcast-windows.ts", "resources/windows/waku.iss", "build.rs", ".github/workflows/release.yml", ".env.site.example"];
    const transpiler=new Bun.Transpiler({ loader: "ts", target: "bun" });
    for(const file of files){ const text=source(file); expect(text.includes(String.fromCharCode(0))).toBe(false); if(file.endsWith(".ts")) expect(() => transpiler.transformSync(text)).not.toThrow(); }
  });
  test("CLI fail-closed preflight is offline and never invokes Rust", async () => {
    const script=new URL("./brand-config.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const run=async(env: BrandEnvironment, args: string[]=[]) => {
      const child=Bun.spawn([process.execPath, script, "--require-site", "--platform", "all", ...args], { env: { SystemRoot: process.env.SystemRoot, ...env }, stdout: "pipe", stderr: "pipe" });
      return { exit: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
    };
    expect((await run({})).exit).not.toBe(0);
    expect((await run(fixture())).exit).toBe(0);
    expect((await run(fixture(), ["--version"])).exit).not.toBe(0);
    expect((await run(fixture(), ["--unexpected"])).exit).not.toBe(0);
    const shell=await run(fixture(), ["--shell"]); expect(shell.exit).toBe(0);
    expect(shell.out).toContain("site_public_key='" + publicFixture + "'");
    expect(shell.out).toContain("bundle_identifier='test.fixture.client'");
    const rc=await run(fixture(), ["--version", "1.0.0-cjq.1-rc.1"]); expect(rc.exit).not.toBe(0); expect(rc.err).toContain("not supported");
  });
});
