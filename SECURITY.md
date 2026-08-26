# Security policy

LedgerLens handles private portfolio data and server-only brokerage credentials.
It is read-only by design and does not include order, modify, or cancel APIs.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, leaked credential, or
private financial record. Use the repository's private security-advisory
reporting channel when it is available. Otherwise, do not publish exploit
details or secrets; contact the repository owner through a previously verified
private channel.

Include the affected revision, a minimal reproduction, expected impact, and
whether real credentials or data may have been exposed. Never attach a real
`.env` file, access token, account number, portfolio export, or screenshot.

## Deployment boundary

- Public deployments must remain in Demo mode without Toss or relay secrets.
- Live data is supported only on loopback personal use or an owner-only host
  with a trusted server-side authentication boundary.
- The browser credential form is a loopback-only personal setup surface. It
  encrypts credentials into the ignored `private-data/` directory and is not a
  shared or hosted multi-user vault. Do not reverse-proxy that route for public
  use.
- A local vault passphrase is never stored and cannot be recovered. Do not put
  the passphrase, vault file, or a decrypted credential in an issue or backup
  that is accessible to others.
- `LEDGERLENS_TRUST_PLATFORM_AUTH=true` is safe only when the platform strips
  caller-supplied identity headers and injects its authenticated owner ID.
- Relay deployments must run exactly one token-owning process behind TLS and a
  WTS-registered fixed egress IP.
- Never expose `.env*`, `.dev.vars*`, `.wrangler`, `.impeccable`, local D1 data,
  CSV exports, or build logs in an issue, artifact, image, or Docker context.

See `docs/SECURITY_ARCHITECTURE.md` for the complete trust and data boundaries.
