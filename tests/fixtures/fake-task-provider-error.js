#!/usr/bin/env node

const diagnostics = {
  claude: 'invalid_api_key: Authorization: Bearer opaque-provider-credential-value',
  codex: 'rate_limit_exceeded: Authorization: Bearer opaque-provider-credential-value',
  gemini: 'IneligibleTierError: UNSUPPORTED_CLIENT api_key=opaque-provider-credential-value',
};

const [provider, channel, scenario] = process.argv.slice(2);
if (!Object.prototype.hasOwnProperty.call(diagnostics, provider)) {
  throw new Error(`Unsupported fake provider: ${provider}`);
}
if (channel !== 'stdout' && channel !== 'stderr') {
  throw new Error(`Unsupported fake provider channel: ${channel}`);
}

let diagnostic = diagnostics[provider];
if (scenario === 'credential-assignments') {
  diagnostic =
    "Error: TOKEN=opaque-token-value GITHUB_TOKEN:'opaque-github-token-value' " +
    'OPENROUTER_API_KEY="opaque openrouter key value" signature = opaque-signature-value ' +
    'Authorization: Basic dXNlcjpwYXNzd29yZA== token_count=42 signature_algorithm=ed25519 ' +
    'authorization_status=initialized basic_mode=enabled';
} else if (scenario === 'unterminated-assignment') {
  diagnostic =
    'Error: TOKEN="unterminated assignment secret with spaces\r\nordinary_status=visible';
} else if (scenario === 'unterminated-assignment-single') {
  diagnostic =
    "Error: GITHUB_TOKEN='unterminated single assignment secret with spaces\nphase=ready";
} else if (scenario === 'unterminated-basic') {
  diagnostic = 'Error: Authorization: Basic "unterminated basic secret with spaces\nphase=ready';
} else if (scenario === 'unterminated-basic-single') {
  diagnostic =
    "Error: Proxy-Authorization: Basic 'unterminated single basic secret with spaces\r\nordinary_status=visible";
}

process[channel].write(`${diagnostic}\n`);
process.exitCode = 1;
