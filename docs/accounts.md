# Billing accounts

Named accounts select billing for Claude Code or Codex, using the user's own
subscription within ordinary individual usage. Claude and Kimi credentials are
provisioned manually; Autobuild never runs `claude setup-token`. ChatGPT
accounts use OpenAI's browser authorization through the CLI.

## Dispatcher admission

Before taking the repository lease, a local dispatcher checks every account
selected by an effective primary or alternate route, including internal roles
and agent verify/finalize steps. Unused declared accounts do not block dispatch;
`ab init --validate` still checks them for readiness. Availability means a
nonempty configured environment variable or a matching, safely owned local
refreshing login (`bun ab accounts login NAME --local`). A failed, unsafe,
mismatched local record fails closed. Startup inspects a ready login owned by a
live peer without claiming it, so a second dispatcher can yield to the repository
lease holder; execution claims the login only after acquiring the lease. An external access
token remains usable when no local login record exists. Startup checks presence,
without inference or provider validation. Local worktree Claude execution can
also use the host login without a configured token; sandbox and hosted execution
require the configured credential slot. Missing sources produce one error with
all account names, variable names and remedies, before any work is claimed.

Successor preflight checks the same sources without claiming or refreshing the
predecessor's login. A missing source refuses handoff and raises upgrade
attention while the predecessor stays active. Accepted config changes that
require unavailable accounts hold new account-dependent work.

Hosted ticks resolve selected accounts only from project secrets, never from
deployment credentials or local logins. An absent secret raises one durable
repository condition per account; repeated ticks do not repeat the condition or
spend build infrastructure attempts. Set it with `bun ab secrets set VARIABLE`,
or renew ChatGPT with `bun ab accounts login NAME --project`. The next tick
recovers automatically, without a per-build retry. Running executions continue
to be observed and their policies repaired; controls and cleanup continue.
A provisioning race uses the same repository condition and remains retryable.
Presence and rejection are separate: present but rejected credentials retain
account-specific rejection attention.

For local Claude subscriptions, renew with `claude setup-token` and set the
dispatcher credential variable. For Kimi, replace the membership key in that
variable. For local ChatGPT, sign in again with `bun ab accounts login NAME
--local`. Diagnostics contain source names and remedies, never secret values.

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
subscription accounts require an explicit selection. ChatGPT accounts require explicit selection on Codex; Claude and Kimi accounts
require Claude Code. Incompatible runtime selections are rejected. Repositories with no accounts retain legacy authentication.
Locally a Claude subscription can use its named token or the host login; Kimi
requires its membership key. Invalid credentials need renewal (`claude setup-token`
for Claude, replacement membership key for Kimi); quota and overload failures
retain alternate fallback.

Selected Claude/Kimi credentials stay out of process arguments: each invocation
uses a private 0700 directory and a regular 0600 settings file, removed after
normal exit, launch failure or cancellation. The settings preserve selected-account
authentication precedence over saved user/project settings. Remote settings and
environments continue to contain placeholders only.

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
and makes one minimal request using each account's actual runtime, including
unused accounts, in the disposable sandbox. Hosted ChatGPT credentials use the
metadata readiness boundary described below.


## ChatGPT subscriptions

ChatGPT Plus and Pro are eligible for [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart).
Authorization grants plan usage for eligible Responses requests; it does not
grant access to ChatGPT conversations. Included usage is shared with the plan
and other authorized apps. Plan exhaustion retains configured alternate fallback.

```toml
[accounts.chatgpt]
kind = "chatgpt-subscription"
credentialEnv = "CHATGPT_ACCESS_TOKEN"

[roles.implement]
runtime = "codex"
account = "chatgpt"
```

Run `bun ab accounts login chatgpt --local` on your own machine for a local
dispatcher, or `bun ab accounts login chatgpt --project` for a connected
project. Without a destination flag, connected projects choose project storage;
others choose local storage. The destination is shown before the browser opens.
OpenAI handles consent and authorization. No token is printed.

Local credentials live in protected, ignored main-checkout
`.autobuild/accounts/` state shared by worktrees. Project sign-in transfers
credentials directly to the encrypted refreshing project secret named by
`credentialEnv`; it retains no renewable credential locally. This name
identifies a host access-token slot, not a refresh token supplied in TOML.
ChatGPT accounts must use slots distinct from every other account. Existing
ChatGPT descriptors cannot change during live configuration reload; stop dispatch
before replacing a descriptor, or introduce a new account name.

The stable opaque host identifier belongs to the destination; the issued
client identifier belongs to the authorized ChatGPT registration. Reauthorization
keeps identity and registration associated. Never copy the ambient Codex login.

Exactly one owner refreshes each connection: the local dispatcher or the
hosted refreshing secret. Both owners refresh only at or after the maximum of
any provider earliest-refresh floor and their pre-expiry threshold. Local renewal
uses a one-minute margin; hosted renewal uses ten minutes to tolerate a delayed
five-minute tick. Before refresh is due, still-valid access is supplied unchanged.
Expired access behind a future provider floor is never delivered.
Credentials rotate atomically before delivery. Expired access tokens remain
refreshable after dispatcher downtime; a live validator or dispatcher claim
cannot be displaced. Only a proven dead process or a released claim permits
a successor to own renewal.
Sandboxes hold stable placeholders; only an exact bearer match on
`api.openai.com` receives the current access token at egress. Local Codex uses
an isolated CODEX_HOME and a capability-protected loopback Responses forwarder which
reads current durable state and never refreshes. The shell HOME stays intact
for Git identity and other operator tools. Missing sandbox credentials revoke
only their egress transforms; unrelated routes keep running. If hosted secret
resolution fails, intake and new execution launches wait for recovery. A
revision-fenced observation-only pass uses ready credentials to repair running
policies; if those credentials cannot be read, the project is skipped. A failed policy
update stops the sandbox because revocation could not be confirmed.

A failed or uncertain refresh is terminal for that credential generation.
Sign in again with `bun ab accounts login chatgpt` for the same destination;
do not retry the old refresh token. Token rejection raises account-specific
attention rather than an alternate or retry loop.

For local credentials, `bun ab init --validate` checks the owner and current
credential and makes a minimal Codex request. Validation uses a temporary
exclusive ownership claim only when no dispatcher owns the record. For hosted
project credentials it uses write-only metadata: presence, owner, set time,
refresh status and any refresh-window warning. It never downloads tokens.
**The first hosted build is the live check.** A short refresh-window warning is
advisory and does not revoke a still-valid credential.
