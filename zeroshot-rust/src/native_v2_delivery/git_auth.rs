pub fn encode_basic_credential(token: &str) -> String {
    encode_base64(format!("x-access-token:{token}").as_bytes())
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let character = |index: usize| ALPHABET.get(index).copied().map(char::from).unwrap_or('=');
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let Some(&first) = chunk.first() else {
            continue;
        };
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(character(usize::from(first >> 2)));
        output.push(character(usize::from(
            ((first & 0x03) << 4) | (second >> 4),
        )));
        output.push(if chunk.len() > 1 {
            character(usize::from(((second & 0x0f) << 2) | (third >> 6)))
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            character(usize::from(third & 0x3f))
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_credential_encoding_is_canonical() {
        assert_eq!(
            encode_basic_credential("token"),
            "eC1hY2Nlc3MtdG9rZW46dG9rZW4="
        );
    }
}
