use std::collections::BTreeMap;

use openengine_cluster_protocol::TokenCount;
use serde_json::Value;

use crate::native_v2_contract::TokenUsageDelta;

pub(super) fn message_identity(message: &serde_json::Map<String, Value>) -> Option<&str> {
    message
        .get("id")
        .or_else(|| message.get("uuid"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

#[derive(Clone, Copy, Default)]
pub(super) struct UsageSnapshot {
    input_tokens: Option<TokenCount>,
    output_tokens: Option<TokenCount>,
    cache_read_input_tokens: Option<TokenCount>,
    cache_creation_input_tokens: Option<TokenCount>,
}

impl UsageSnapshot {
    fn merge(&mut self, next: Self) {
        if next.input_tokens.is_some() {
            self.input_tokens = next.input_tokens;
        }
        if next.output_tokens.is_some() {
            self.output_tokens = next.output_tokens;
        }
        if next.cache_read_input_tokens.is_some() {
            self.cache_read_input_tokens = next.cache_read_input_tokens;
        }
        if next.cache_creation_input_tokens.is_some() {
            self.cache_creation_input_tokens = next.cache_creation_input_tokens;
        }
    }

    fn complete(self) -> Option<TokenUsageDelta> {
        Some(TokenUsageDelta {
            input_tokens: self.input_tokens?,
            output_tokens: self.output_tokens?,
            cache_read_input_tokens: self.cache_read_input_tokens,
            cache_creation_input_tokens: self.cache_creation_input_tokens,
        })
    }

    fn has_value(self) -> bool {
        self.input_tokens.is_some()
            || self.output_tokens.is_some()
            || self.cache_read_input_tokens.is_some()
            || self.cache_creation_input_tokens.is_some()
    }
}

#[derive(Default)]
pub(super) struct ProvisionalUsage {
    messages: BTreeMap<String, UsageSnapshot>,
    anonymous: Option<TokenUsageDelta>,
    invalid: bool,
}

impl ProvisionalUsage {
    pub(super) fn invalidate(&mut self) {
        self.invalid = true;
    }

    pub(super) fn replace_message(&mut self, message_id: &str, usage: UsageSnapshot) {
        self.messages.insert(message_id.to_owned(), usage);
    }

    pub(super) fn merge_message(&mut self, message_id: &str, usage: UsageSnapshot) {
        self.messages
            .entry(message_id.to_owned())
            .or_default()
            .merge(usage);
    }

    pub(super) fn add_anonymous(&mut self, usage: UsageSnapshot) {
        if self.invalid {
            return;
        }
        let Some(usage) = usage.complete() else {
            self.invalid = true;
            return;
        };
        self.anonymous = match self.anonymous {
            Some(current) => match add_usage(current, usage) {
                Some(total) => Some(total),
                None => {
                    self.invalid = true;
                    None
                }
            },
            None => Some(usage),
        };
    }

    pub(super) fn total(&self) -> Option<TokenUsageDelta> {
        if self.invalid {
            return None;
        }
        let mut total = self.anonymous;
        for usage in self.messages.values().copied() {
            let usage = usage.complete()?;
            total = Some(match total {
                Some(current) => add_usage(current, usage)?,
                None => usage,
            });
        }
        total
    }
}

#[derive(Clone, Copy)]
pub(super) struct UsageKeys {
    input: UsageKey,
    output: UsageKey,
    cache_read: UsageKey,
    cache_creation: UsageKey,
}

#[derive(Clone, Copy)]
struct UsageKey {
    primary: &'static str,
    alternate: Option<&'static str>,
}

impl UsageKeys {
    pub(super) const CLAUDE_STREAM: Self = Self {
        input: UsageKey::single("input_tokens"),
        output: UsageKey::single("output_tokens"),
        cache_read: UsageKey::single("cache_read_input_tokens"),
        cache_creation: UsageKey::single("cache_creation_input_tokens"),
    };
    const CLAUDE_MODEL: Self = Self {
        input: UsageKey::aliased("inputTokens", "input_tokens"),
        output: UsageKey::aliased("outputTokens", "output_tokens"),
        cache_read: UsageKey::aliased("cacheReadInputTokens", "cache_read_input_tokens"),
        cache_creation: UsageKey::aliased(
            "cacheCreationInputTokens",
            "cache_creation_input_tokens",
        ),
    };
}

pub(super) enum TerminalUsage {
    Empty,
    Valid(TokenUsageDelta),
    Malformed,
}

pub(super) fn parse_terminal_usage(
    camel_model_usage: Option<&Value>,
    snake_model_usage: Option<&Value>,
    usage: Option<&Value>,
) -> TerminalUsage {
    let model_usage = match aliased_value(camel_model_usage, snake_model_usage) {
        Ok(value) => classify_usage(value, parse_model_usage),
        Err(()) => TerminalUsage::Malformed,
    };
    match model_usage {
        TerminalUsage::Empty => classify_usage(usage, |value| {
            parse_usage_snapshot(value, UsageKeys::CLAUDE_MODEL)?.complete()
        }),
        terminal => terminal,
    }
}

fn aliased_value<'a>(
    primary: Option<&'a Value>,
    alternate: Option<&'a Value>,
) -> Result<Option<&'a Value>, ()> {
    match (primary, alternate) {
        (Some(primary), Some(alternate)) if primary != alternate => Err(()),
        (Some(value), _) | (None, Some(value)) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

fn classify_usage(
    value: Option<&Value>,
    parse: impl FnOnce(Option<&Value>) -> Option<TokenUsageDelta>,
) -> TerminalUsage {
    match value {
        None | Some(Value::Null) => TerminalUsage::Empty,
        Some(Value::Object(object)) if object.is_empty() => TerminalUsage::Empty,
        value => parse(value).map_or(TerminalUsage::Malformed, TerminalUsage::Valid),
    }
}

impl UsageKey {
    const fn single(primary: &'static str) -> Self {
        Self {
            primary,
            alternate: None,
        }
    }

    const fn aliased(primary: &'static str, alternate: &'static str) -> Self {
        Self {
            primary,
            alternate: Some(alternate),
        }
    }
}

pub(super) fn parse_usage_snapshot(
    value: Option<&Value>,
    keys: UsageKeys,
) -> Option<UsageSnapshot> {
    let usage = value?.as_object()?;
    let snapshot = UsageSnapshot {
        input_tokens: optional_count(usage, keys.input)?,
        output_tokens: optional_count(usage, keys.output)?,
        cache_read_input_tokens: optional_count(usage, keys.cache_read)?,
        cache_creation_input_tokens: optional_count(usage, keys.cache_creation)?,
    };
    snapshot.has_value().then_some(snapshot)
}

fn optional_count(
    usage: &serde_json::Map<String, Value>,
    key: UsageKey,
) -> Option<Option<TokenCount>> {
    let primary = usage.get(key.primary);
    let alternate = key.alternate.and_then(|name| usage.get(name));
    match (primary, alternate) {
        (Some(primary), Some(alternate)) if primary != alternate => None,
        (Some(value), _) | (None, Some(value)) => {
            Some(Some(TokenCount::new(value.as_u64()?).ok()?))
        }
        (None, None) => Some(None),
    }
}

fn parse_model_usage(value: Option<&Value>) -> Option<TokenUsageDelta> {
    let models = value?.as_object()?;
    let mut total = None;
    for model in models.values() {
        let usage = parse_usage_snapshot(Some(model), UsageKeys::CLAUDE_MODEL)?.complete()?;
        total = Some(match total {
            Some(current) => add_usage(current, usage)?,
            None => usage,
        });
    }
    total
}

fn add_usage(left: TokenUsageDelta, right: TokenUsageDelta) -> Option<TokenUsageDelta> {
    Some(TokenUsageDelta {
        input_tokens: left.input_tokens.checked_add(right.input_tokens)?,
        output_tokens: left.output_tokens.checked_add(right.output_tokens)?,
        cache_read_input_tokens: add_optional_tokens(
            left.cache_read_input_tokens,
            right.cache_read_input_tokens,
        )?,
        cache_creation_input_tokens: add_optional_tokens(
            left.cache_creation_input_tokens,
            right.cache_creation_input_tokens,
        )?,
    })
}

fn add_optional_tokens(
    left: Option<TokenCount>,
    right: Option<TokenCount>,
) -> Option<Option<TokenCount>> {
    match (left, right) {
        (Some(left), Some(right)) => left.checked_add(right).map(Some),
        _ => Some(None),
    }
}
