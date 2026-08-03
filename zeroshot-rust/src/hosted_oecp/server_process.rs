use std::error::Error;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};

use super::server::{production_backend, serve, OECP_PORT};

pub async fn run_server_process() -> Result<(), Box<dyn Error>> {
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        tokio::time::timeout(
            Duration::from_secs(2),
            TcpStream::connect(("127.0.0.1", OECP_PORT)),
        )
        .await??;
        println!("zeroshot-oecp-server ready");
        return Ok(());
    }
    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], OECP_PORT))).await?;
    serve(listener, production_backend(), shutdown_signal()).await?;
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
    let _ = tokio::signal::ctrl_c().await;
}
