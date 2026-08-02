//! OS-native configuration/data/cache/runtime namespace resolution.
//!
//! Every directory is derived only from an explicit environment snapshot passed in by the
//! caller. This module never reads `~/.zeroshot`, npm configuration, or any other Node-product
//! location, and [`production_env_snapshot`] is the only place it touches real process
//! environment state.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::*;

pub const APP_NAMESPACE: &str = "zeroshot-rust";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeNamespace {
    config: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    runtime: PathBuf,
}

impl NativeNamespace {
    #[must_use]
    pub fn config(&self) -> &Path {
        &self.config
    }

    #[must_use]
    pub fn data(&self) -> &Path {
        &self.data
    }

    #[must_use]
    pub fn cache(&self) -> &Path {
        &self.cache
    }

    #[must_use]
    pub fn runtime(&self) -> &Path {
        &self.runtime
    }

    #[must_use]
    pub fn profiles_file(&self) -> PathBuf {
        self.config.join("profiles.json")
    }
}

/// Snapshots the real process environment. The only `std::env` call site in this module;
/// everything else in [`resolve_namespace`] takes its environment as an explicit map so tests
/// never touch real process state.
#[must_use]
pub fn production_env_snapshot() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

pub fn resolve_namespace(
    env: &BTreeMap<String, String>,
) -> Result<NativeNamespace, NativeSettingsError> {
    let (config_base, data_base, cache_base, runtime_base) = platform_bases(env)?;
    let namespace = NativeNamespace {
        config: config_base.join(APP_NAMESPACE),
        data: data_base.join(APP_NAMESPACE),
        cache: cache_base.join(APP_NAMESPACE),
        runtime: runtime_base.join(APP_NAMESPACE),
    };
    apply_directory_overrides(namespace, env)
}

fn non_empty<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

#[cfg(unix)]
fn home_dir(env: &BTreeMap<String, String>) -> Result<PathBuf, NativeSettingsError> {
    non_empty(env, "HOME").map(PathBuf::from).ok_or_else(|| {
        NativeSettingsError::new("HOME", "must be set to resolve the native namespace")
    })
}

#[cfg(target_os = "macos")]
fn platform_bases(
    env: &BTreeMap<String, String>,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), NativeSettingsError> {
    let home = home_dir(env)?;
    let application_support = home.join("Library").join("Application Support");
    let caches = home.join("Library").join("Caches");
    let config_base = application_support.clone();
    let data_base = application_support.join("data");
    let cache_base = caches.clone();
    let runtime_base = caches.join("runtime");
    Ok((config_base, data_base, cache_base, runtime_base))
}

#[cfg(windows)]
fn platform_bases(
    env: &BTreeMap<String, String>,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), NativeSettingsError> {
    let appdata = non_empty(env, "APPDATA").ok_or_else(|| {
        NativeSettingsError::new("APPDATA", "must be set to resolve the native namespace")
    })?;
    let local_appdata = non_empty(env, "LOCALAPPDATA").ok_or_else(|| {
        NativeSettingsError::new(
            "LOCALAPPDATA",
            "must be set to resolve the native namespace",
        )
    })?;
    let config_base = PathBuf::from(appdata);
    let data_base = PathBuf::from(local_appdata);
    let cache_base = data_base.join("cache");
    let runtime_base = cache_base.join("runtime");
    Ok((config_base, data_base, cache_base, runtime_base))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn xdg_or_home(
    env: &BTreeMap<String, String>,
    xdg_key: &str,
    home_suffix: &[&str],
) -> Result<PathBuf, NativeSettingsError> {
    if let Some(value) = non_empty(env, xdg_key) {
        return Ok(PathBuf::from(value));
    }
    let mut path = home_dir(env)?;
    path.extend(home_suffix);
    Ok(path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_bases(
    env: &BTreeMap<String, String>,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), NativeSettingsError> {
    let config_base = xdg_or_home(env, "XDG_CONFIG_HOME", &[".config"])?;
    let data_base = xdg_or_home(env, "XDG_DATA_HOME", &[".local", "share"])?;
    let cache_base = xdg_or_home(env, "XDG_CACHE_HOME", &[".cache"])?;
    let runtime_base = match non_empty(env, "XDG_RUNTIME_DIR") {
        Some(value) => PathBuf::from(value),
        None => cache_base.join("runtime"),
    };
    Ok((config_base, data_base, cache_base, runtime_base))
}

fn apply_directory_overrides(
    mut namespace: NativeNamespace,
    env: &BTreeMap<String, String>,
) -> Result<NativeNamespace, NativeSettingsError> {
    namespace.config = override_dir(env, "ZEROSHOT_RUST_CONFIG_DIR", namespace.config)?;
    namespace.data = override_dir(env, "ZEROSHOT_RUST_DATA_DIR", namespace.data)?;
    namespace.cache = override_dir(env, "ZEROSHOT_RUST_CACHE_DIR", namespace.cache)?;
    namespace.runtime = override_dir(env, "ZEROSHOT_RUST_RUNTIME_DIR", namespace.runtime)?;
    Ok(namespace)
}

fn override_dir(
    env: &BTreeMap<String, String>,
    key: &'static str,
    default: PathBuf,
) -> Result<PathBuf, NativeSettingsError> {
    match env.get(key) {
        None => Ok(default),
        Some(value) if value.is_empty() => Err(NativeSettingsError::new(key, "must not be empty")),
        Some(value) => Ok(PathBuf::from(value)),
    }
}
