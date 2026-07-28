pub mod driver;
pub mod local;
pub mod process;
pub mod types;

use async_trait::async_trait;

pub use types::*;

#[async_trait]
pub trait ExecutionRuntime: Send + Sync {
    async fn dispatch(&self, command: ExecutionCommand) -> DispatchObservation;

    async fn inspect(&self, control: ExecutionControl) -> ExecutionObservation;

    async fn cancel(&self, control: ExecutionControl) -> CancelObservation;
}
