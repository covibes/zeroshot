//! Shared `Deserialize`/`Serialize` glue for validated wire types: a type whose invariants are
//! checked by a `validate()` method that both serde directions must call, so an invalid value can
//! never be produced or accepted on the wire. Used by every type in this crate that follows this
//! pattern (a private `*Wire` mirror for `Deserialize`, a private `*Ref` for `Serialize`), so the
//! boilerplate exists exactly once rather than being hand-copied per type.
macro_rules! impl_validate_gated_wire {
    ($ty:ident, $wire:ty, $ref_ty:ident) => {
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let value = Self::from(<$wire>::deserialize(deserializer)?);
                value.validate().map_err(serde::de::Error::custom)?;
                Ok(value)
            }
        }

        impl serde::Serialize for $ty {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                self.validate().map_err(serde::ser::Error::custom)?;
                $ref_ty::from(self).serialize(serializer)
            }
        }
    };
}

pub(crate) use impl_validate_gated_wire;
