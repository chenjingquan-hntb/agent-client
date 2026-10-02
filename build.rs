//! Windows executable resources.
//!
//! Explorer, the taskbar, and the Programs list all read the icon and version
//! block out of the PE image itself — there is no bundle or desktop entry to
//! carry them. Site builds additionally share the offline packaging preflight.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    validate_site_release();
    export_sparkle_public_key();
    export_brand();

    #[cfg(target_os = "windows")]
    {
        // GPUI's Taffy layout and text shaping recurse deeply enough to
        // overflow the 1 MiB the MSVC linker defaults to.
        println!("cargo:rustc-link-arg-bins=/stack:{}", 8 * 1024 * 1024);
        embed_windows_resources();
    }
}

/// Share the script preflight with CI and packaging instead of maintaining a
/// weaker second validator. Only opt-in site builds require Bun; development
/// keeps the existing toolchain and defaults. No signing material is accessed.
fn validate_site_release() {
    for name in [
        "SUB2API_SITE_RELEASE",
        "SUB2API_BRAND_NAME",
        "SUB2API_BRAND_BUNDLE_ID",
        "SUB2API_BRAND_WEBSITE",
        "SUB2API_MANAGED_SERVICE_URL",
        "SUB2API_MANAGED_SERVICE_ALT_URLS",
        "SUB2API_RELEASES_BASE_URL",
        "SUB2API_DATA_DIR_NAME",
        "SUB2API_PLATFORM_DATA_DIR_NAME",
        "SUB2API_WINDOWS_APP_ID",
        "SUB2API_PUBLISHER",
        "SUB2API_SPARKLE_PUBLIC_KEY",
        "WAKU_DOWNLOAD_URL_PREFIX",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=scripts/brand-config.ts");
    let flag = std::env::var("SUB2API_SITE_RELEASE").unwrap_or_default();
    if flag.is_empty() || flag == "0" {
        return;
    }
    assert_eq!(flag, "1", "SUB2API_SITE_RELEASE must be 1, 0, or unset");
    assert_eq!(
        std::env::var("PROFILE").as_deref(),
        Ok("release"),
        "SUB2API_SITE_RELEASE=1 requires a release build"
    );
    let target = std::env::var("CARGO_CFG_TARGET_OS").expect("cargo target OS");
    let platform = match target.as_str() {
        "macos" => "macos",
        "windows" => "windows",
        _ => panic!("Custom site releases are unsupported on {target} (including Linux)"),
    };
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/brand-config.ts");
    let status = std::process::Command::new("bun")
        .arg(script)
        .args(["--require-site", "--platform", platform, "--version"])
        .arg(std::env::var("CARGO_PKG_VERSION").expect("cargo package version"))
        .status()
        .expect("site release preflight requires Bun on PATH");
    assert!(
        status.success(),
        "site release configuration preflight failed"
    );
}

/// Republish the configured public key (legacy Info.plist fallback) as a compile-time
/// constant.
///
/// The Windows updater verifies the same EdDSA signatures `generate_appcast`
/// writes, against the same SUB2API_SPARKLE_PUBLIC_KEY that packaging and the
/// Windows signer read. Site preflight requires an own key before this runs.
fn export_sparkle_public_key() {
    const PLIST: &str = "resources/Info.plist";
    const KEY: &str = "<key>SUPublicEDKey</key>";

    println!("cargo:rerun-if-changed={PLIST}");

    println!("cargo:rerun-if-env-changed=SUB2API_SPARKLE_PUBLIC_KEY");
    if let Ok(value) = std::env::var("SUB2API_SPARKLE_PUBLIC_KEY") {
        if !value.trim().is_empty() {
            println!(
                "cargo:rustc-env=WAKU_SPARKLE_PUBLIC_ED_KEY={}",
                value.trim()
            );
            return;
        }
    }

    let plist = std::fs::read_to_string(PLIST).expect("read the app Info.plist");
    let value = plist
        .split_once(KEY)
        .and_then(|(_, rest)| rest.split_once("<string>"))
        .and_then(|(_, rest)| rest.split_once("</string>"))
        .map(|(value, _)| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| panic!("{PLIST} has no SUPublicEDKey"));

    println!("cargo:rustc-env=WAKU_SPARKLE_PUBLIC_ED_KEY={value}");
}

/// Fork addition: resolve brand strings once, here, so `const` items that need
/// a literal (the Windows appcast URL) and the Windows version block both read
/// the same values.
///
/// Defaults must match `sub2api::brand`; CI overrides them by setting the same
/// variables in the build environment.
fn export_brand() {
    for (name, fallback) in [
        ("SUB2API_BRAND_NAME", "CheapRouter"),
        (
            "SUB2API_RELEASES_BASE_URL",
            "https://s3.cheaprouter.cc/cheaprouter-releases",
        ),
    ] {
        println!("cargo:rerun-if-env-changed={name}");
        let value = std::env::var(name)
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.to_owned());
        println!("cargo:rustc-env={name}_RESOLVED={value}");
    }
}

#[cfg(target_os = "windows")]
fn embed_windows_resources() {
    const ICON: &str = "resources/windows/AppIcon.ico";

    println!("cargo:rerun-if-changed={ICON}");

    let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(ICON);
    // The resource compiler reads `.rc` as C source, so a Windows path
    // separator has to survive as a literal backslash.
    let icon = icon.to_string_lossy().replace('\\', "\\\\");

    let package_version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    // VERSIONINFO wants four numeric fields; Waku's version has three.
    let mut fields = package_version
        .split(['.', '-', '+'])
        .map(|field| field.parse::<u16>().unwrap_or(0))
        .chain(std::iter::repeat(0));
    let file_version = format!(
        "{},{},{},{}",
        fields.next().unwrap_or(0),
        fields.next().unwrap_or(0),
        fields.next().unwrap_or(0),
        fields.next().unwrap_or(0),
    );
    let description = std::env::var("CARGO_PKG_DESCRIPTION").unwrap_or_default();
    let brand = std::env::var("SUB2API_BRAND_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "CheapRouter".to_owned());
    println!("cargo:rerun-if-env-changed=SUB2API_PUBLISHER");
    let publisher = std::env::var("SUB2API_PUBLISHER").unwrap_or_else(|_| brand.clone());
    let escape_rc = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
    let brand = escape_rc(&brand);
    let publisher = escape_rc(&publisher);
    let binary = brand.to_lowercase().replace(' ', "-");

    let resources = format!(
        r#"1 ICON "{icon}"

1 VERSIONINFO
FILEVERSION {file_version}
PRODUCTVERSION {file_version}
FILEFLAGSMASK 0x3fL
FILEFLAGS 0x0L
FILEOS 0x40004L
FILETYPE 0x1L
FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName", "{publisher}\0"
            VALUE "FileDescription", "{description}\0"
            VALUE "FileVersion", "{package_version}\0"
            VALUE "InternalName", "{binary}\0"
            VALUE "OriginalFilename", "{binary}.exe\0"
            VALUE "ProductName", "{brand}\0"
            VALUE "ProductVersion", "{package_version}\0"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x0409, 1200
    END
END
"#
    );

    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    let script = out_dir.join("waku.rc");
    std::fs::write(&script, resources).expect("write the resource script");

    // GPUI embeds the application manifest through its own resource script,
    // so this one only claims the icon and version block.
    embed_resource::compile(&script, embed_resource::NONE)
        .manifest_optional()
        .expect("compile Windows resources");
}
