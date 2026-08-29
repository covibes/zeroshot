use std::collections::BTreeMap;
use std::io::{Read, Write};

use openengine_cluster_protocol::{
    ConnectionDeleteRequest, ConnectionListRequest, ConnectionSetRequest, EnvironmentVariableName,
    StaticConnectionValues,
};

use crate::native_v2_cli::{
    CliOutcome, ConnectionInput, ConnectionSetCommand, NativeV2CliBackend, NativeV2CliCommand,
    NativeV2CliError,
};

use super::write_json;

pub(super) async fn execute_connection<B, W>(
    command: NativeV2CliCommand,
    backend: &B,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    W: Write,
{
    match command {
        NativeV2CliCommand::ConnectionList(route) => {
            let result = backend
                .connection_list(
                    route.target.as_deref(),
                    ConnectionListRequest { scope: route.scope },
                )
                .await?;
            write_json(output, &result)?;
            Ok(CliOutcome::Completed)
        }
        NativeV2CliCommand::ConnectionSet(command) => {
            execute_connection_set(command, backend, output).await
        }
        NativeV2CliCommand::ConnectionDelete { route, key } => {
            let result = backend
                .connection_delete(
                    route.target.as_deref(),
                    ConnectionDeleteRequest {
                        key,
                        scope: route.scope,
                    },
                )
                .await?;
            write_json(output, &result)?;
            Ok(CliOutcome::Completed)
        }
        _ => Err(NativeV2CliError::Usage(
            "expected a connection operation".to_owned(),
        )),
    }
}

async fn execute_connection_set<B, W>(
    command: ConnectionSetCommand,
    backend: &B,
    output: &mut W,
) -> Result<CliOutcome, NativeV2CliError>
where
    B: NativeV2CliBackend,
    W: Write,
{
    let values = read_connection_values(command.input)?;
    let result = backend
        .connection_set(
            command.route.target.as_deref(),
            ConnectionSetRequest {
                key: command.key,
                scope: command.route.scope,
                values,
            },
        )
        .await?;
    write_json(output, &result)?;
    Ok(CliOutcome::Completed)
}

fn read_connection_values(
    input: ConnectionInput,
) -> Result<StaticConnectionValues, NativeV2CliError> {
    let values = match input {
        ConnectionInput::Prompt(fields) => fields
            .into_iter()
            .map(|field| {
                let value = rpassword::prompt_password(format!("{}: ", field.as_str()))?;
                Ok((field, value))
            })
            .collect::<Result<BTreeMap<_, _>, std::io::Error>>()?,
        ConnectionInput::JsonStdin => {
            let mut encoded = String::new();
            std::io::stdin().lock().read_to_string(&mut encoded)?;
            serde_json::from_str::<BTreeMap<EnvironmentVariableName, String>>(&encoded).map_err(
                |error| NativeV2CliError::Usage(format!("connection JSON is invalid: {error}")),
            )?
        }
    };
    StaticConnectionValues::new(values).map_err(|error| NativeV2CliError::Usage(error.to_string()))
}
