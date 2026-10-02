//! One-shot startup migration of legacy storage.
//!
//! Existing default builds keep the Waku-to-CheapRouter migration. Custom
//! home/platform storage, or a `SUB2API_SITE_RELEASE=1` build, never imports
//! legacy state (including credentials) automatically. Migration requires the
//! explicit build-time opt-in `SUB2API_ALLOW_LEGACY_STORAGE_MIGRATION=1`.
//! Any other supplied value disables it, including for default builds.
//!
//! A rename only happens when the source exists and the destination does not.
//! There is no merge or deletion: the destination wins, other sources remain
//! untouched, and failed renames warn without blocking startup. A custom
//! target prefers CheapRouter state over older Waku state. The original paths
//! can be restored manually with the app stopped and the destination absent.

use std::path::{Path, PathBuf};

use crate::brand;

/// Rename permitted legacy storage before any caller opens files.
/// Returns warnings for failed renames; callers log them and continue.
pub fn migrate_legacy_storage() -> Vec<String> {
    let home = dirs::home_dir();
    // data_local_dir: app.db, updater state and WebView2 profiles. data_dir:
    // Computer Use helpers. cache_dir: model catalogs. macOS may share roots.
    let roots: Vec<PathBuf> = [dirs::data_local_dir(), dirs::data_dir(), dirs::cache_dir()]
        .into_iter()
        .flatten()
        .collect();
    migrate_storage(
        home.as_deref(),
        &roots,
        brand::DATA_DIR_NAME,
        brand::DATA_DIRECTORY_NAME_RELEASE,
        brand::DATA_DIRECTORY_NAME_DEBUG,
        option_env!("SUB2API_ALLOW_LEGACY_STORAGE_MIGRATION"),
        matches!(option_env!("SUB2API_SITE_RELEASE"), Some("1")),
    )
}

fn is_default_storage(home_name: &str, release_name: &str, debug_name: &str) -> bool {
    home_name == ".cheaprouter"
        && release_name == "CheapRouter"
        && debug_name == "CheapRouter Debug"
}

fn migrate_storage(
    home: Option<&Path>,
    roots: &[PathBuf],
    home_name: &str,
    release_name: &str,
    debug_name: &str,
    opt_in: Option<&str>,
    site_release: bool,
) -> Vec<String> {
    let default_storage = is_default_storage(home_name, release_name, debug_name);
    let enabled = match opt_in {
        Some("1") => true,
        Some(_) => false,
        None => default_storage && !site_release,
    };
    if !enabled {
        return Vec::new();
    }

    let mut pairs: Vec<(PathBuf, PathBuf)> = Vec::new();
    if let Some(home) = home {
        for source in [".cheaprouter", ".waku"] {
            pairs.push((home.join(source), home.join(home_name)));
        }
        // Slash commands still use a shared, hard-coded config namespace.
        // Do not mutate it for a custom-storage build, even with opt-in.
        if default_storage {
            pairs.push((
                home.join(".config").join("waku"),
                home.join(".config").join("cheaprouter"),
            ));
        }
    }
    for root in roots {
        for (source, target) in [
            ("CheapRouter", release_name),
            ("Waku", release_name),
            ("CheapRouter Debug", debug_name),
            ("Waku Debug", debug_name),
        ] {
            pairs.push((root.join(source), root.join(target)));
        }
    }

    let mut warnings = Vec::new();
    for (old, new) in pairs {
        if old != new {
            rename_pair(&old, &new, &mut warnings);
        }
    }
    warnings
}

fn rename_pair(old: &Path, new: &Path, warnings: &mut Vec<String>) {
    if !old.is_dir() || new.exists() {
        return;
    }
    if let Err(error) = std::fs::rename(old, new) {
        warnings.push(format!(
            "could not migrate {} to {}: {error}",
            old.display(),
            new.display()
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sub2api-migrate-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn renames_legacy_directory_with_contents() {
        let root = temp_root("rename");
        let old = root.join(".waku");
        std::fs::create_dir_all(old.join("projects")).unwrap();
        std::fs::write(old.join("settings.json"), b"{}").unwrap();

        let mut warnings = Vec::new();
        rename_pair(&old, &root.join(".cheaprouter"), &mut warnings);

        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!old.exists());
        assert!(root.join(".cheaprouter/projects").is_dir());
        assert_eq!(
            std::fs::read(root.join(".cheaprouter/settings.json")).unwrap(),
            b"{}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_new_directory_wins_and_legacy_is_left_alone() {
        let root = temp_root("both");
        let old = root.join(".waku");
        let new = root.join(".cheaprouter");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("marker"), b"old").unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("marker"), b"new").unwrap();

        let mut warnings = Vec::new();
        rename_pair(&old, &new, &mut warnings);

        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(std::fs::read(old.join("marker")).unwrap(), b"old");
        assert_eq!(std::fs::read(new.join("marker")).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absent_legacy_directory_is_a_no_op() {
        let root = temp_root("absent");
        let mut warnings = Vec::new();
        rename_pair(
            &root.join(".waku"),
            &root.join(".cheaprouter"),
            &mut warnings,
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!root.join(".cheaprouter").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    // All fixtures are inert marker files under a unique temporary root. Never
    // call the public OS-root migration entry point or change process env here.
    struct StorageFixture {
        root: PathBuf,
        home: PathBuf,
        platform: PathBuf,
    }

    impl StorageFixture {
        fn new(tag: &str) -> Self {
            let root = temp_root(tag);
            let home = root.join("home");
            let platform = root.join("platform");
            std::fs::create_dir_all(&home).unwrap();
            std::fs::create_dir_all(&platform).unwrap();
            Self {
                root,
                home,
                platform,
            }
        }

        fn seed(&self, root: &Path, directory: &str, marker: &[u8]) {
            let path = root.join(directory);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("marker"), marker).unwrap();
        }

        fn migrate(
            &self,
            names: (&str, &str, &str),
            opt_in: Option<&str>,
            site_release: bool,
        ) -> Vec<String> {
            migrate_storage(
                Some(&self.home),
                std::slice::from_ref(&self.platform),
                names.0,
                names.1,
                names.2,
                opt_in,
                site_release,
            )
        }

        fn assert_marker(&self, root: &Path, directory: &str, marker: &[u8]) {
            assert_eq!(
                std::fs::read(root.join(directory).join("marker")).unwrap(),
                marker
            );
        }
    }

    impl Drop for StorageFixture {
        fn drop(&mut self) {
            let root = self.root.canonicalize().unwrap();
            let temp = std::env::temp_dir().canonicalize().unwrap();
            assert_eq!(root.parent(), Some(temp.as_path()));
            assert!(
                root.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("sub2api-migrate-")
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    const DEFAULT_NAMES: (&str, &str, &str) = (".cheaprouter", "CheapRouter", "CheapRouter Debug");
    const CUSTOM_NAMES: (&str, &str, &str) =
        (".identity-test", "Identity Test", "Identity Test Debug");

    #[test]
    fn custom_storage_does_not_import_any_legacy_state_without_opt_in() {
        for names in [
            (CUSTOM_NAMES.0, DEFAULT_NAMES.1, DEFAULT_NAMES.2),
            (DEFAULT_NAMES.0, CUSTOM_NAMES.1, DEFAULT_NAMES.2),
            (DEFAULT_NAMES.0, DEFAULT_NAMES.1, CUSTOM_NAMES.2),
            CUSTOM_NAMES,
        ] {
            let fixture = StorageFixture::new("custom-blocked");
            for name in [".waku", ".cheaprouter", ".config/waku"] {
                fixture.seed(&fixture.home, name, b"inert-home-fixture");
            }
            for name in ["Waku", "Waku Debug", "CheapRouter", "CheapRouter Debug"] {
                fixture.seed(&fixture.platform, name, b"inert-platform-fixture");
            }
            assert!(fixture.migrate(names, None, false).is_empty());
            for name in [".waku", ".cheaprouter", ".config/waku"] {
                fixture.assert_marker(&fixture.home, name, b"inert-home-fixture");
            }
            for name in ["Waku", "Waku Debug", "CheapRouter", "CheapRouter Debug"] {
                fixture.assert_marker(&fixture.platform, name, b"inert-platform-fixture");
            }
            assert!(!fixture.home.join(CUSTOM_NAMES.0).exists());
            assert!(!fixture.platform.join(CUSTOM_NAMES.1).exists());
            assert!(!fixture.platform.join(CUSTOM_NAMES.2).exists());
            assert!(!fixture.home.join(".config/cheaprouter").exists());
        }
    }

    #[test]
    fn site_release_blocks_default_storage_migration() {
        let fixture = StorageFixture::new("site-blocked");
        fixture.seed(&fixture.home, ".waku", b"home");
        fixture.seed(&fixture.home, ".config/waku", b"commands");
        fixture.seed(&fixture.platform, "Waku", b"release");
        fixture.seed(&fixture.platform, "Waku Debug", b"debug");
        assert!(fixture.migrate(DEFAULT_NAMES, None, true).is_empty());
        fixture.assert_marker(&fixture.home, ".waku", b"home");
        fixture.assert_marker(&fixture.home, ".config/waku", b"commands");
        fixture.assert_marker(&fixture.platform, "Waku", b"release");
        fixture.assert_marker(&fixture.platform, "Waku Debug", b"debug");
        assert!(!fixture.home.join(DEFAULT_NAMES.0).exists());
        assert!(!fixture.platform.join(DEFAULT_NAMES.1).exists());
        assert!(!fixture.platform.join(DEFAULT_NAMES.2).exists());
    }

    #[test]
    fn only_literal_one_is_an_opt_in() {
        for opt_in in ["", "0", "false", "true", "yes", " 1", "1 "] {
            let fixture = StorageFixture::new("disabled");
            fixture.seed(&fixture.home, ".waku", b"home");
            fixture.seed(&fixture.platform, "Waku", b"release");
            for (names, site_release) in [(DEFAULT_NAMES, false), (CUSTOM_NAMES, true)] {
                assert!(
                    fixture
                        .migrate(names, Some(opt_in), site_release)
                        .is_empty()
                );
            }
            fixture.assert_marker(&fixture.home, ".waku", b"home");
            fixture.assert_marker(&fixture.platform, "Waku", b"release");
            assert!(!fixture.home.join(DEFAULT_NAMES.0).exists());
            assert!(!fixture.home.join(CUSTOM_NAMES.0).exists());
        }
    }

    #[test]
    fn default_build_retains_upstream_migration_and_commands() {
        let fixture = StorageFixture::new("default");
        fixture.seed(&fixture.home, ".waku", b"home");
        fixture.seed(&fixture.home, ".config/waku", b"commands");
        fixture.seed(&fixture.platform, "Waku", b"release");
        fixture.seed(&fixture.platform, "Waku Debug", b"debug");
        assert!(fixture.migrate(DEFAULT_NAMES, None, false).is_empty());
        fixture.assert_marker(&fixture.home, DEFAULT_NAMES.0, b"home");
        fixture.assert_marker(&fixture.home, ".config/cheaprouter", b"commands");
        fixture.assert_marker(&fixture.platform, DEFAULT_NAMES.1, b"release");
        fixture.assert_marker(&fixture.platform, DEFAULT_NAMES.2, b"debug");
        assert!(!fixture.home.join(".waku").exists());
    }

    #[test]
    fn explicit_opt_in_uses_custom_targets_and_prefers_cheaprouter() {
        let fixture = StorageFixture::new("opt-in");
        fixture.seed(&fixture.home, ".cheaprouter", b"newer-home");
        fixture.seed(&fixture.home, ".waku", b"older-home");
        fixture.seed(&fixture.home, ".config/waku", b"commands");
        for (name, marker) in [
            ("CheapRouter", b"newer-release".as_slice()),
            ("Waku", b"older-release".as_slice()),
            ("CheapRouter Debug", b"newer-debug".as_slice()),
            ("Waku Debug", b"older-debug".as_slice()),
        ] {
            fixture.seed(&fixture.platform, name, marker);
        }
        assert!(fixture.migrate(CUSTOM_NAMES, Some("1"), true).is_empty());
        fixture.assert_marker(&fixture.home, CUSTOM_NAMES.0, b"newer-home");
        fixture.assert_marker(&fixture.home, ".waku", b"older-home");
        fixture.assert_marker(&fixture.home, ".config/waku", b"commands");
        fixture.assert_marker(&fixture.platform, CUSTOM_NAMES.1, b"newer-release");
        fixture.assert_marker(&fixture.platform, CUSTOM_NAMES.2, b"newer-debug");
        fixture.assert_marker(&fixture.platform, "Waku", b"older-release");
        fixture.assert_marker(&fixture.platform, "Waku Debug", b"older-debug");
        assert!(!fixture.home.join(".config/cheaprouter").exists());
        assert!(fixture.migrate(CUSTOM_NAMES, Some("1"), true).is_empty());
        fixture.assert_marker(&fixture.home, ".waku", b"older-home");
    }

    #[test]
    fn explicit_opt_in_can_migrate_waku_directly_to_custom_targets() {
        let fixture = StorageFixture::new("waku-custom");
        fixture.seed(&fixture.home, ".waku", b"home");
        fixture.seed(&fixture.platform, "Waku", b"release");
        fixture.seed(&fixture.platform, "Waku Debug", b"debug");
        assert!(fixture.migrate(CUSTOM_NAMES, Some("1"), false).is_empty());
        fixture.assert_marker(&fixture.home, CUSTOM_NAMES.0, b"home");
        fixture.assert_marker(&fixture.platform, CUSTOM_NAMES.1, b"release");
        fixture.assert_marker(&fixture.platform, CUSTOM_NAMES.2, b"debug");
    }

    #[test]
    fn existing_custom_targets_are_never_merged_or_overwritten() {
        let fixture = StorageFixture::new("custom-existing");
        fixture.seed(&fixture.home, ".cheaprouter", b"legacy");
        fixture.seed(&fixture.home, CUSTOM_NAMES.0, b"current");
        fixture.seed(&fixture.platform, "CheapRouter", b"legacy");
        fixture.seed(&fixture.platform, CUSTOM_NAMES.1, b"current");
        assert!(fixture.migrate(CUSTOM_NAMES, Some("1"), false).is_empty());
        fixture.assert_marker(&fixture.home, ".cheaprouter", b"legacy");
        fixture.assert_marker(&fixture.home, CUSTOM_NAMES.0, b"current");
        fixture.assert_marker(&fixture.platform, "CheapRouter", b"legacy");
        fixture.assert_marker(&fixture.platform, CUSTOM_NAMES.1, b"current");
    }

    #[test]
    fn absent_home_and_duplicate_platform_roots_are_supported() {
        let fixture = StorageFixture::new("duplicate-roots");
        fixture.seed(&fixture.platform, "Waku", b"release");
        let roots = [fixture.platform.clone(), fixture.platform.clone()];
        assert!(
            migrate_storage(
                None,
                &roots,
                DEFAULT_NAMES.0,
                DEFAULT_NAMES.1,
                DEFAULT_NAMES.2,
                None,
                false,
            )
            .is_empty()
        );
        fixture.assert_marker(&fixture.platform, DEFAULT_NAMES.1, b"release");
        assert!(
            migrate_storage(
                None,
                &[],
                CUSTOM_NAMES.0,
                CUSTOM_NAMES.1,
                CUSTOM_NAMES.2,
                Some("1"),
                true,
            )
            .is_empty()
        );
    }

    #[test]
    fn failed_migration_warns_and_keeps_source_contents() {
        let fixture = StorageFixture::new("failure");
        fixture.seed(&fixture.home, ".waku", b"home");
        let names = ("absent-parent/target", CUSTOM_NAMES.1, CUSTOM_NAMES.2);
        let warnings = fixture.migrate(names, Some("1"), false);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("could not migrate"));
        fixture.assert_marker(&fixture.home, ".waku", b"home");
        assert!(!fixture.home.join(names.0).exists());
    }
}
