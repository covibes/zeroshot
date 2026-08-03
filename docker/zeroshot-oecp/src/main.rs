use std::{error::Error, net::SocketAddr, sync::Arc};

use tokio::net::TcpListener;
use zeroshot_engine::hosted_oecp::{serve, HostedBackend, OECP_PORT};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        println!("zeroshot OECP server ready");
        return Ok(());
    }
    let backend = Arc::new(HostedBackend::new());
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], OECP_PORT))).await?;
    serve(listener, backend, shutdown_signal()).await?;
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler must install");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _result = tokio::signal::ctrl_c().await;
}
