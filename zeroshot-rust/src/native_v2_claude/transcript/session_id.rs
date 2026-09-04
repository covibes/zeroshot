use serde_json::Value;

pub(super) fn record_session_id(
    value: Option<&Value>,
    retained: &mut Option<String>,
) -> Result<(), &'static str> {
    let Some(value) = value else {
        return Ok(());
    };
    let session_id = value
        .as_str()
        .ok_or("Claude output contained an invalid session identifier")?;
    if session_id.is_empty() || session_id.contains('\0') {
        return Err("Claude output contained an invalid session identifier");
    }
    match retained.as_deref() {
        Some(existing) if existing != session_id => {
            Err("Claude output changed session identifier during one turn")
        }
        Some(_) => Ok(()),
        None => {
            *retained = Some(session_id.to_owned());
            Ok(())
        }
    }
}
