//! Compile-time contract tests without adding a cross-crate dependency.
//! Include the actual protocol identity source so drift is caught under every
//! build profile/environment in the documented matrix. No app or credentials
//! are opened by these tests.

#[path = "../../waku-protocol/src/identity.rs"]
mod protocol_identity;

use sub2api::brand;

#[test]
fn home_and_platform_storage_match_protocol_identity() {
    assert_eq!(brand::DATA_DIR_NAME, protocol_identity::DATA_DIR_NAME);
    assert_eq!(
        brand::DATA_DIRECTORY_NAME_RELEASE,
        protocol_identity::DATA_DIRECTORY_NAME_RELEASE,
    );
    assert_eq!(
        brand::DATA_DIRECTORY_NAME_DEBUG,
        protocol_identity::DATA_DIRECTORY_NAME_DEBUG,
    );
    assert_eq!(
        brand::DATA_DIRECTORY_NAME,
        protocol_identity::DATA_DIRECTORY_NAME
    );
    assert_eq!(
        brand::DATA_DIR_NAME,
        option_env!("SUB2API_DATA_DIR_NAME").unwrap_or(".cheaprouter"),
    );
}

#[test]
fn platform_storage_uses_common_and_debug_overrides() {
    let common = option_env!("SUB2API_PLATFORM_DATA_DIR_NAME");
    assert_eq!(
        protocol_identity::DATA_DIRECTORY_NAME_RELEASE,
        common.unwrap_or("CheapRouter"),
    );
    assert_eq!(
        protocol_identity::DATA_DIRECTORY_NAME_DEBUG,
        option_env!("SUB2API_PLATFORM_DATA_DIR_NAME_DEBUG")
            .or(common)
            .unwrap_or("CheapRouter Debug"),
    );
    let selected = if cfg!(debug_assertions) {
        protocol_identity::DATA_DIRECTORY_NAME_DEBUG
    } else {
        protocol_identity::DATA_DIRECTORY_NAME_RELEASE
    };
    assert_eq!(protocol_identity::DATA_DIRECTORY_NAME, selected);
}

#[test]
fn app_identity_uses_profile_specific_build_configuration() {
    let expected = if cfg!(debug_assertions) {
        option_env!("SUB2API_BRAND_BUNDLE_ID_DEBUG").unwrap_or("sh.waku.dev")
    } else {
        option_env!("SUB2API_BRAND_BUNDLE_ID").unwrap_or("sh.waku")
    };
    assert_eq!(protocol_identity::APP_ID, expected);
    assert_eq!(
        brand::BUNDLE_ID,
        option_env!("SUB2API_BRAND_BUNDLE_ID").unwrap_or("org.cheaprouter.desktop"),
    );
    if !cfg!(debug_assertions) && option_env!("SUB2API_BRAND_BUNDLE_ID").is_some() {
        assert_eq!(protocol_identity::APP_ID, brand::BUNDLE_ID);
    }
}

#[test]
fn app_name_preserves_existing_profile_defaults() {
    let default = if cfg!(debug_assertions) {
        "CheapRouter Debug"
    } else {
        "CheapRouter"
    };
    assert_eq!(
        protocol_identity::APP_NAME,
        option_env!("SUB2API_BRAND_NAME").unwrap_or(default),
    );
}
