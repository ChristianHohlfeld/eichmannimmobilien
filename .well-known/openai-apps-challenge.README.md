# OpenAI domain verification (`openai-apps-challenge`)

When the ChatGPT / Codex plugin portal shows a domain-verification token, host it as **plain text only** at:

```text
https://immobilieneichmann.de/.well-known/openai-apps-challenge
```

Repo path to create/update when the token is known:

```text
.well-known/openai-apps-challenge
```

Rules (OpenAI docs):

- Exact token string only — not JSON, not a list of tokens.
- HTTPS origin must be the MCP hostname (`immobilieneichmann.de`) or an eligible parent.
- Do not invent a token; paste the portal value, commit/deploy, then click Verify Domain in the portal.

Until a token exists, this README is the durable handoff. Do **not** commit a fake challenge file.
