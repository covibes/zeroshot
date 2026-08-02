//! Named native-profile inheritance, canonicalization, and secret-free digesting.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::fmt::Write as _;
use std::io::Read as _;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::*;
use crate::provider_value::validate_collection_len;

/// Maximum number of `extends` hops walked from any profile before its inheritance chain is
/// rejected, whether or not it ever cycles back on itself.
const MAX_PROFILE_INHERITANCE_DEPTH: usize = 8;
const MAX_PROFILE_FILE_BYTES: u64 = 1024 * 1024;

crate::provider_value::digest_type!(ProfileDigest, NativeSettingsError, "profile digest");

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "ProfileWire", rename_all = "camelCase")]
pub struct Profile {
    id: ProfileId,
    extends: Option<ProfileId>,
    settings: NativeSettingsSchema,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileWire {
    id: ProfileId,
    #[serde(default)]
    extends: Option<ProfileId>,
    settings: NativeSettingsSchema,
}

impl TryFrom<ProfileWire> for Profile {
    type Error = NativeSettingsError;

    fn try_from(wire: ProfileWire) -> Result<Self, Self::Error> {
        NativeSettingsError::checked(Self {
            id: wire.id,
            extends: wire.extends,
            settings: wire.settings,
        })
    }
}

impl Profile {
    pub fn new(
        id: ProfileId,
        extends: Option<ProfileId>,
        settings: NativeSettingsSchema,
    ) -> Result<Self, NativeSettingsError> {
        NativeSettingsError::checked(Self {
            id,
            extends,
            settings,
        })
    }

    #[must_use]
    pub fn id(&self) -> &ProfileId {
        &self.id
    }

    #[must_use]
    pub fn extends(&self) -> Option<&ProfileId> {
        self.extends.as_ref()
    }

    #[must_use]
    pub fn settings(&self) -> &NativeSettingsSchema {
        &self.settings
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileFile {
    pub version: u32,
    pub profiles: Vec<Profile>,
}

/// Validated, cycle-free named-profile set: no duplicate ids, no unknown `extends` targets, and
/// every inheritance chain within [`MAX_PROFILE_INHERITANCE_DEPTH`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileRegistry(BTreeMap<ProfileId, Profile>);

impl ProfileRegistry {
    pub fn new(profiles: Vec<Profile>) -> Result<Self, NativeSettingsError> {
        validate_collection_len(profiles.len())
            .map_err(|error| NativeSettingsError::new("profile registry", error))?;

        let mut map = BTreeMap::new();
        for profile in profiles {
            if map.insert(profile.id().clone(), profile).is_some() {
                return Err(NativeSettingsError::new(
                    "profile registry",
                    "duplicate profile id",
                ));
            }
        }

        for profile in map.values() {
            if let Some(extends) = profile.extends() {
                if !map.contains_key(extends) {
                    return Err(NativeSettingsError::new(
                        "profile extends",
                        "unknown profile",
                    ));
                }
            }
        }

        let ids: Vec<ProfileId> = map.keys().cloned().collect();
        for id in &ids {
            detect_cycle(&map, id)?;
        }

        Ok(Self(map))
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn get(&self, id: &ProfileId) -> Option<&Profile> {
        self.0.get(id)
    }

    /// Folds every profile's inheritance chain root-to-leaf via
    /// [`NativeSettingsSchema::layer_over`], so a child's fields win over an ancestor's. Rebuilt
    /// fresh on every call: resolving one profile never mutates another's prior result.
    #[must_use]
    pub fn canonicalize(&self) -> BTreeMap<ProfileId, NativeSettingsSchema> {
        self.0
            .keys()
            .map(|id| (id.clone(), self.resolve_chain(id)))
            .collect()
    }

    fn resolve_chain(&self, id: &ProfileId) -> NativeSettingsSchema {
        let mut chain = Vec::new();
        let mut current = id;
        loop {
            let profile = self
                .0
                .get(current)
                .expect("validated profile registry contains every id in its own chain");
            chain.push(profile);
            match profile.extends() {
                Some(next) => current = next,
                None => break,
            }
        }
        chain
            .into_iter()
            .rev()
            .fold(NativeSettingsSchema::default(), |accumulated, profile| {
                accumulated.layer_over(profile.settings())
            })
    }

    /// Deterministic, secret-free digest of the canonicalized profile set: unaffected by
    /// insertion order, changes whenever any profile's resolved settings change.
    pub fn digest(&self) -> Result<ProfileDigest, NativeSettingsError> {
        let canonical = self.canonicalize();
        let bytes = serde_json::to_vec(&canonical)
            .map_err(|error| NativeSettingsError::new("profile digest", error.to_string()))?;
        let mut digest_hex = String::with_capacity(64);
        for byte in Sha256::digest(&bytes) {
            write!(&mut digest_hex, "{byte:02x}").expect("writing to a string cannot fail");
        }
        ProfileDigest::new(digest_hex)
    }

    /// A missing profile file resolves to an empty registry; a present-but-malformed file is a
    /// bounded error naming the path.
    pub fn load_from(path: &Path) -> Result<Self, NativeSettingsError> {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Self::new(Vec::new());
            }
            Err(error) => {
                return Err(NativeSettingsError::new(
                    "profile file",
                    format!("{}: {error}", path.display()),
                ));
            }
        };
        let metadata = file.metadata().map_err(|error| {
            NativeSettingsError::new("profile file", format!("{}: {error}", path.display()))
        })?;
        if metadata.len() > MAX_PROFILE_FILE_BYTES {
            return Err(NativeSettingsError::new(
                "profile file",
                format!(
                    "{}: exceeds {MAX_PROFILE_FILE_BYTES}-byte limit",
                    path.display()
                ),
            ));
        }

        let mut contents = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_PROFILE_FILE_BYTES + 1)
            .read_to_end(&mut contents)
            .map_err(|error| {
                NativeSettingsError::new("profile file", format!("{}: {error}", path.display()))
            })?;
        if contents.len() as u64 > MAX_PROFILE_FILE_BYTES {
            return Err(NativeSettingsError::new(
                "profile file",
                format!(
                    "{}: exceeds {MAX_PROFILE_FILE_BYTES}-byte limit",
                    path.display()
                ),
            ));
        }

        let file: ProfileFile = serde_json::from_slice(&contents).map_err(|error| {
            NativeSettingsError::new("profile file", format!("{}: {error}", path.display()))
        })?;
        if file.version != NATIVE_SETTINGS_SCHEMA_VERSION {
            return Err(NativeSettingsError::new(
                "profile file version",
                "unsupported profile file version",
            ));
        }
        Self::new(file.profiles)
    }
}

fn detect_cycle(
    map: &BTreeMap<ProfileId, Profile>,
    start: &ProfileId,
) -> Result<(), NativeSettingsError> {
    let mut visited = BTreeSet::new();
    visited.insert(start.clone());
    let mut current = start;
    for _ in 0..MAX_PROFILE_INHERITANCE_DEPTH {
        let profile = map
            .get(current)
            .expect("profile extends targets are validated present before cycle detection");
        let Some(next) = profile.extends() else {
            return Ok(());
        };
        if !visited.insert(next.clone()) {
            return Err(NativeSettingsError::new(
                "profile extends",
                "profile inheritance forms a cycle",
            ));
        }
        current = next;
    }
    let profile = map
        .get(current)
        .expect("profile extends targets are validated present before cycle detection");
    if profile.extends().is_some() {
        return Err(NativeSettingsError::new(
            "profile extends",
            "profile inheritance exceeds the maximum depth",
        ));
    }
    Ok(())
}
