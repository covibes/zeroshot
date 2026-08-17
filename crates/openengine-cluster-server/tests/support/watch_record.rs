use openengine_cluster_server::watch::{PublicEventRecord, WatchEventStream, WatchStreamItem};

use super::assert_value::AssertValue;

pub(super) async fn next_record(stream: &mut WatchEventStream) -> PublicEventRecord {
    match stream.next().await.assert_value() {
        WatchStreamItem::Record(record) => Some(record),
        WatchStreamItem::Closed { .. } => None,
    }
    .assert_value()
}
