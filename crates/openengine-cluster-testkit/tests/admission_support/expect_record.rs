use openengine_cluster_server::watch::{PublicEventRecord, WatchStreamItem};

pub fn expect_record(item: Option<WatchStreamItem>) -> PublicEventRecord {
    match item {
        Some(WatchStreamItem::Record(record)) => record,
        other => panic!("expected a record, got {other:?}"),
    }
}
