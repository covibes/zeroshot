use openengine_cluster_server::watch::{PublicEventRecord, WatchStreamItem};

pub fn expect_record(item: Option<WatchStreamItem>) -> PublicEventRecord {
    match item {
        Some(WatchStreamItem::Record(record)) => Some(record),
        _ => None,
    }
    .assert_value_with("expected a watch record")
}

use openengine_cluster_testkit::assertions::AssertValue;
