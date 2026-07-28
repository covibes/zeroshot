use super::super::{ResourceId, StoreError};
use super::SqliteLedgerStore;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqliteSettings {
    pub journal_mode: String,
    pub synchronous: i64,
    pub foreign_keys: i64,
    pub busy_timeout_ms: i64,
    pub application_id: i64,
    pub schema_version: i64,
}

impl SqliteLedgerStore {
    pub fn settings(&self, resource: &ResourceId) -> Result<SqliteSettings, StoreError> {
        let connection = self.connect_existing(resource)?;
        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(|_| StoreError::Storage)?;
        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(|_| StoreError::Storage)?;
        let foreign_keys: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .map_err(|_| StoreError::Storage)?;
        let busy_timeout: i64 = connection
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .map_err(|_| StoreError::Storage)?;
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(|_| StoreError::Storage)?;
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| StoreError::Storage)?;
        Ok(SqliteSettings {
            journal_mode,
            synchronous,
            foreign_keys,
            busy_timeout_ms: busy_timeout,
            application_id,
            schema_version: user_version,
        })
    }
}
