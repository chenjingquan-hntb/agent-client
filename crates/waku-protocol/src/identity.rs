//! Shared application identity used by the daemon and desktop client.
//!
//! Branding and storage constants use the same build-time variables and
//! fallbacks as `sub2api::brand`; neither crate depends on the other.
//! Custom storage never imports legacy credentials by default. Migration is
//! handled at startup by `sub2api::migrate::migrate_legacy_storage`.
//!
//! The default app ids remain upstream's for existing builds. An independent
//! build must supply its confirmed bundle id, matching the platform metadata
//! and Linux desktop entry. Debug keeps its default id unless separately
//! overridden; no suffix or production identity is invented here.

#[cfg(debug_assertions)]
pub const APP_NAME: &str = match option_env!("SUB2API_BRAND_NAME") {
    Some(name) => name,
    None => "CheapRouter Debug",
};
#[cfg(not(debug_assertions))]
pub const APP_NAME: &str = match option_env!("SUB2API_BRAND_NAME") {
    Some(name) => name,
    None => "CheapRouter",
};

#[cfg(debug_assertions)]
pub const APP_ID: &str = match option_env!("SUB2API_BRAND_BUNDLE_ID_DEBUG") {
    Some(id) => id,
    None => "sh.waku.dev",
};
#[cfg(not(debug_assertions))]
pub const APP_ID: &str = match option_env!("SUB2API_BRAND_BUNDLE_ID") {
    Some(id) => id,
    None => "sh.waku",
};

/// Home-directory dot-folder holding settings, sessions, projectless
/// workspaces and worktrees (`~/.cheaprouter`).
pub const DATA_DIR_NAME: &str = match option_env!("SUB2API_DATA_DIR_NAME") {
    Some(name) => name,
    None => ".cheaprouter",
};

/// Platform data/cache directory for release builds. A directory name, not
/// an absolute path. Independent of the display name and home dot-folder.
pub const DATA_DIRECTORY_NAME_RELEASE: &str = match option_env!("SUB2API_PLATFORM_DATA_DIR_NAME") {
    Some(name) => name,
    None => "CheapRouter",
};

/// Debug-specific override; a common override otherwise applies to both
/// profiles. Set both variables to keep debug and release storage separate.
pub const DATA_DIRECTORY_NAME_DEBUG: &str =
    match option_env!("SUB2API_PLATFORM_DATA_DIR_NAME_DEBUG") {
        Some(name) => name,
        None => match option_env!("SUB2API_PLATFORM_DATA_DIR_NAME") {
            Some(name) => name,
            None => "CheapRouter Debug",
        },
    };

#[cfg(debug_assertions)]
pub const DATA_DIRECTORY_NAME: &str = DATA_DIRECTORY_NAME_DEBUG;
#[cfg(not(debug_assertions))]
pub const DATA_DIRECTORY_NAME: &str = DATA_DIRECTORY_NAME_RELEASE;
