# Billing accounts

Named accounts select billing for the unmodified Claude Code runtime, using
only the user's own subscription within ordinary individual usage. Provision
credentials manually on the dispatcher host; Autobuild never runs
`claude setup-token`, signs in, or collects its output.

```toml
[accounts.personal]
kind = "claude-subscription"
credentialEnv = "CLAUDE_CODE_OAUTH_TOKEN"

[accounts.kimi]
kind = "kimi-code"
credentialEnv = "KIMI_CODE_KEY"
region = "overseas"

[accounts.kimi-china]
kind = "kimi-code"
credentialEnv = "KIMI_CHINA_KEY"
region = "china"

[roles.implement]
runtime = "claude"
account = "kimi"
model = "kimi-for-coding"
```

`account` inherits independently on roles and alternates. Without an explicit
selection, a Claude route chooses the sole Claude subscription account; multiple
subscription accounts require an explicit selection. Account references on other
runtimes are rejected. Repositories with no accounts retain legacy authentication.
Locally a Claude subscription can use its named token or the host login; Kimi
requires its membership key. Invalid credentials need renewal (`claude setup-token`
for Claude, replacement membership key for Kimi); quota and overload failures
retain alternate fallback.

Choose the region of your Kimi membership. The default `overseas` selects
`https://api.kimi.ai/coding/`; `china` selects `https://api.kimi.com/coding/`.
The base URL and egress hostname are fixed together and cannot be overridden
independently. There is no cross-region retry or assertion that keys work across
regions. Claude Code keeps its native User-Agent.

In Vercel Sandbox the guest holds stable nonsecret placeholders, including when
credential variables are explicitly allowlisted. The host egress policy replaces
an exact account placeholder header only on its provider's exact hostname.
The next dispatcher observation tick refreshes credentials for subsequent
requests without reprovisioning. Changing a local dispatcher's `.env` still needs
a restart. Accounts are deployment-owned descriptors; configuration artifacts
contain variable names, never values. Validation reports host credential presence
and makes one minimal Claude Code model request per declared account, including
unused accounts, in the disposable sandbox.

