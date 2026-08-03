# Claude Provider

## Authentication

### Interactive Login (Default)

```bash
claude login
```

### API Key (Direct Anthropic)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Keep the key in the local process environment. Zeroshot provider/settings
commands do not persist provider credentials.

### AWS Bedrock

Generate a long-term API key from [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/home#/api-keys) → API keys → Generate long-term API key.

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=eu-central-1
export AWS_BEARER_TOKEN_BEDROCK=ABSK...
```

Keep the Bedrock token in the local process environment. Provider configuration
is manual-only, and credential values must not be written to Zeroshot settings.
