#!/usr/bin/env bun
// Release-only configuration. No private keys, subprocesses or network access.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export type BrandEnvironment = Record<string, string | undefined>;
export type ReleasePlatform = "macos" | "windows" | "all" | "linux";
export const legacyPublicKey = "IUd9ZU+OYtZIzWi/MmSrVKXY4cbfrTC3ahtEz52H8ZI=";
export const legacyWindowsAppId = "7DC6C35B-FA40-4A95-B37A-626BF64556C5";
const defaults = {
  name: "CheapRouter", bundleId: "sh.waku", website: "https://cheaprouter.cc",
  managedUrl: "https://cheaprouter.cc", releasesUrl: "https://s3.cheaprouter.cc/cheaprouter-releases",
  dataDir: ".cheaprouter", platformDataName: "CheapRouter",
  windowsAppId: legacyWindowsAppId, publisher: "CheapRouter", publicKey: undefined as string | undefined,
};
export const brandEnvNames = {
  name: "SUB2API_BRAND_NAME", bundleId: "SUB2API_BRAND_BUNDLE_ID",
  website: "SUB2API_BRAND_WEBSITE", managedUrl: "SUB2API_MANAGED_SERVICE_URL",
  releasesUrl: "SUB2API_RELEASES_BASE_URL", dataDir: "SUB2API_DATA_DIR_NAME",
  platformDataName: "SUB2API_PLATFORM_DATA_DIR_NAME", windowsAppId: "SUB2API_WINDOWS_APP_ID",
  publisher: "SUB2API_PUBLISHER", publicKey: "SUB2API_SPARKLE_PUBLIC_KEY",
} as const;

export function isSiteRelease(env: BrandEnvironment = process.env): boolean {
  const flag = env.SUB2API_SITE_RELEASE;
  if (flag !== undefined && flag !== "" && flag !== "0" && flag !== "1") {
    throw new Error("SUB2API_SITE_RELEASE must be 1 (site release), 0, or unset (development).");
  }
  return flag === "1";
}

export function assertStableClientVersion(version: string): void {
  if (version !== version.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      version.split(".").some(field => Number(field) > 999)) {
    throw new Error(`Unsupported client release version "${version}": only plain X.Y.Z (fields <= 999); cjq/RC updater integration is not supported.`);
  }
}

const oldIdentity = /cheaprouter|waku/i;
function own(value: string, envName: string): void {
  if (oldIdentity.test(value)) throw new Error(`${envName} must not reuse CheapRouter/Waku identity or hosts.`);
}
function safeName(value: string, envName: string): void {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`${envName} must be a safe product/directory name (no path or installer syntax).`);
  }
}
function siteUrl(value: string, envName: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${envName} must be an absolute HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      value.endsWith("/") || /[\s\\'"<>{}\x00-\x1f]/.test(value) ||
      !url.hostname.includes(".") || /(?:^|\.)localhost$|\.invalid$|^example\.(com|org|net)$/i.test(url.hostname)) {
    throw new Error(`${envName} must be an explicit HTTPS base URL without credentials, query, fragment, or trailing slash.`);
  }
  own(value, envName);
  own(url.hostname, envName);
  if (url.href.replace(/\/$/, "") !== value) throw new Error(`${envName} must use a canonical URL (no encoded hosts or dot segments).`);
}
export function validatePublicKey(value: string): string {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, "base64").length !== 32 ||
      Buffer.from(value, "base64").toString("base64") !== value ||
      Buffer.from(value, "base64").every(byte => byte === 0)) {
    throw new Error("SUB2API_SPARKLE_PUBLIC_KEY must be a canonical base64 32-byte Ed25519 PUBLIC key.");
  }
  return value;
}

export function resolveBrandConfig(
  env: BrandEnvironment = process.env,
  options: { platform?: ReleasePlatform; version?: string; requireSite?: boolean } = {},
) {
  const siteRelease = isSiteRelease(env);
  if (options.requireSite && !siteRelease) throw new Error("CI requires explicit SUB2API_SITE_RELEASE=1.");
  const platform = options.platform ?? "all";
  if (!["macos", "windows", "all", "linux"].includes(platform)) throw new Error("Unsupported release platform.");
  if (siteRelease && platform === "linux") throw new Error("Custom site Linux releases are not supported.");
  if (options.version !== undefined) assertStableClientVersion(options.version);
  const config = { ...defaults, siteRelease };
  for (const [field, envName] of Object.entries(brandEnvNames)) {
    const value = env[envName];
    const required = siteRelease && (!["windowsAppId", "publisher"].includes(field) || platform !== "macos");
    if (required && (!value || value !== value.trim())) throw new Error(`${envName} is required and must not contain surrounding whitespace for a site release.`);
    if (value) (config as Record<string, unknown>)[field] = siteRelease ? value : value.trim();
  }
  if (config.publicKey) validatePublicKey(config.publicKey);
  if (!siteRelease) return config;
  // Product name is also the artifact basename; keep it compatible with sync.
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(config.name)) {
    throw new Error("SUB2API_BRAND_NAME has a current artifact naming limitation: site releases require ASCII [A-Za-z][A-Za-z0-9_-]* (no spaces, Unicode, dots, or leading digits).");
  }
  for (const field of ["name", "platformDataName", "publisher"] as const) {
    if (field === "publisher" && platform === "macos" && !env.SUB2API_PUBLISHER) continue;
    safeName(config[field], brandEnvNames[field]); own(config[field], brandEnvNames[field]);
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*){2,}$/.test(config.bundleId)) throw new Error("SUB2API_BRAND_BUNDLE_ID must be reverse-DNS (at least three components).");
  own(config.bundleId, brandEnvNames.bundleId);
  if (!/^\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(config.dataDir)) throw new Error("SUB2API_DATA_DIR_NAME must be a single home dot-directory, not a path.");
  own(config.dataDir, brandEnvNames.dataDir);
  for (const field of ["website", "managedUrl", "releasesUrl"] as const) siteUrl(config[field], brandEnvNames[field]);
  for (const alternate of (env.SUB2API_MANAGED_SERVICE_ALT_URLS ?? "").split(",").filter(Boolean)) siteUrl(alternate, "SUB2API_MANAGED_SERVICE_ALT_URLS");
  if (platform !== "macos" || env.SUB2API_WINDOWS_APP_ID) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.windowsAppId) || config.windowsAppId.toUpperCase() === legacyWindowsAppId) throw new Error("SUB2API_WINDOWS_APP_ID must be an own stable GUID without braces, not the previous fork's AppId.");
  }
  if (config.publicKey === legacyPublicKey) throw new Error("SUB2API_SPARKLE_PUBLIC_KEY must not reuse the previous fork's public update key.");
  if (env.WAKU_DOWNLOAD_URL_PREFIX && env.WAKU_DOWNLOAD_URL_PREFIX !== config.releasesUrl + "/") throw new Error("WAKU_DOWNLOAD_URL_PREFIX must match SUB2API_RELEASES_BASE_URL + '/' for a site release.");
  return config;
}

export function releaseDownloadPrefix(env: BrandEnvironment = process.env, platform: ReleasePlatform = "all"): string {
  const config = resolveBrandConfig(env, { platform });
  return config.siteRelease ? config.releasesUrl + "/" : env.WAKU_DOWNLOAD_URL_PREFIX ?? config.releasesUrl + "/";
}
export function assertSiteEnclosureUrl(url: string, prefix: string): void {
  if (!url.startsWith(prefix)) throw new Error("Site appcast enclosure must stay under SUB2API_RELEASES_BASE_URL (including history/deltas).");
  const parsed = new URL(url);
  const base = new URL(prefix);
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || /cheaprouter|waku/i.test(parsed.hostname)) {
    throw new Error("Site appcast enclosure must not route to another or legacy host.");
  }
}
export function cargoReleaseVersion(): string {
  const cargo = readFileSync(resolve(import.meta.dir, "../Cargo.toml"), "utf8");
  const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error("Cargo.toml has no package version.");
  return version;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: {
    platform: { type: "string", default: "all" }, version: { type: "string" },
    "require-site": { type: "boolean", default: false }, shell: { type: "boolean", default: false },
  } });
  const config = resolveBrandConfig(process.env, {
    platform: values.platform as ReleasePlatform,
    version: values.version ?? cargoReleaseVersion(),
    requireSite: values["require-site"],
  });
  if (values.shell) {
    // Fixed variable names, POSIX-quoted values; no eval of user-supplied syntax.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    for (const [name, value] of Object.entries({ app_name: config.name, bundle_identifier: config.bundleId, site_feed_url: config.releasesUrl + "/appcast.xml", site_public_key: config.publicKey ?? "" })) console.log(name + "=" + quote(value));
  } else console.log(`Release configuration OK (site=${config.siteRelease}, platform=${values.platform}). Only plain X.Y.Z supported.`);
}
