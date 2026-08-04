use std::error::Error;

use zeroshot_engine::hosted_oecp::run_server_process;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    run_server_process().await
}
