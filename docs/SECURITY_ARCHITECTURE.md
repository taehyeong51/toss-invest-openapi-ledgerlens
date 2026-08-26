# LedgerLens security architecture

LedgerLens is read-only by design. This repository does not call any Toss order,
modify, or cancel endpoint.

## Runtime modes

| Mode | Intended runtime | Toss credentials here? | Network path |
| --- | --- | --- | --- |
| `demo` | Local preview, CI, Sites preview | No | No Toss network calls |
| `relay` | Private Sites deployment | No | Sites server route -> fixed-IP relay -> Toss |
| `direct` | Private server with registered fixed egress IP | Yes, in server env or the encrypted local vault | Server -> Toss |

`demo` is the safe default. A live failure must remain visibly unavailable; it
must not be replaced with demo data because that would hide stale or simulated
portfolio information.

## Why the relay exists

Toss checks every API request against the IP allowlist configured in WTS. A
default Cloudflare Worker does not provide a dedicated, stable outbound IP, so
the Sites deployment must not own the Toss client secret or call Toss directly.
The production path uses a small authenticated service on a fixed-egress host.

The relay must expose semantic read operations rather than an arbitrary proxy.
Its outbound allowlist is limited to token issuance, accounts, holdings, prices,
exchange rate, buying power, and stock reference data. Browser input must never
select an upstream URL, method, account header, or authorization header.

## Relay ingress boundary

The same LedgerLens application can run as the relay on a fixed-egress host,
but only in `direct` mode. It exposes one server-to-server operation:
`GET /api/relay/portfolio`. The route rejects query parameters and does not
accept a request body, upstream URL, account selector, arbitrary method, or
order operation.

The route authenticates the caller before reading configuration or invoking the
portfolio loader. `LEDGERLENS_RELAY_SHARED_TOKEN` is a high-entropy, relay-only
bearer secret. It must equal `TOSS_RELAY_TOKEN` in the Sites runtime but is not a
Toss access token. `LEDGERLENS_RELAY_ACCOUNT_REF` is a stable opaque account
reference; it must equal `TOSS_RELAY_ACCOUNT_KEY` in Sites. The response carries
that reference in `X-LedgerLens-Account-Ref`, allowing the consumer to reject a
validly authenticated response from the wrong relay account.

Before returning data, the fixed host revalidates the normalized public
portfolio contract. The Sites consumer independently enforces JSON content
type, a two MiB body limit, a fresh canonical timestamp, a masked account
number, exactly one `KR`, `US`, and `CASH` allocation, the expected account
reference, manual redirect handling, and bounded timeout behavior. Neither side
forwards unknown response fields.

## Token ownership

Toss allows one valid access token per API client. Issuing a new token
invalidates the previous token. A single relay process therefore owns token
issuance and protects refresh with a single-flight lock. It refreshes using the
returned `expires_in` with a safety skew and performs at most one synchronized
refresh-and-replay after an upstream 401.

Do not run local direct mode with the same client credentials as a live relay.
Use a separate client or stop the live relay first.

The production relay must be one process. Multiple replicas may issue tokens at
the same time and invalidate each other. Horizontal scaling is allowed only
after a distributed single-token manager has been designed and tested.

## Local personal credential vault

The Data screen exposes a credential setup flow only when the browser and API
request both use `localhost`, `127.0.0.1`, or loopback IPv6. Every mutation also
requires an exact same-origin `Origin`, an operation-specific
`X-LedgerLens-Intent` header, JSON content type, an exact object shape, and a
2,048-byte body limit. Non-loopback requests fail before vault or Toss access.

The server validates the Client ID and Client Secret against Toss account-list
access before saving. Browser responses contain only a temporary zero-based
selection value, account type, and masked final four digits. Full account
numbers and Toss `accountSeq` identifiers remain server-only.

The selected credentials and account identifier are encrypted using
PBKDF2-SHA-256 (310,000 iterations, random 128-bit salt) and AES-256-GCM (random
96-bit IV and authenticated context) in
`private-data/toss-credentials.v1.json`. Writes use a temporary file followed
by an atomic rename, and the file is excluded from Git and Docker contexts.
The passphrase is not stored. Decrypted credentials live only in process memory
for eight hours, are cleared on explicit lock or timeout, and disappear on
server restart.

This vault is for one person's local or self-hosted process. It does not add
user authentication, tenant isolation, a server master-key service, secret
recovery, or safe key intake to a public deployment. A true multi-user service
requires an authenticated user boundary plus per-tenant envelope encryption
with a managed KMS; that is intentionally outside the current scope.

## Data and cache boundary

- Client ID, Client Secret, Toss access token, and relay credential are
  server-only. Direct credentials may use server environment variables or the
  encrypted loopback vault; they must never use a `NEXT_PUBLIC_` name.
- Account responses use `Cache-Control: private, no-store`,
  `Cloudflare-CDN-Cache-Control: no-store`, and `Pragma: no-cache`.
- Full account numbers and `accountSeq` values never cross the browser boundary.
- Logs may contain an internal endpoint label, status, latency, and Toss
  `requestId`; they must not contain credentials, bearer headers, or account
  identifiers.
- Money and quantities remain decimal strings at the API boundary. Calculations
  must use exact decimal arithmetic before persistent analytics are introduced.

## Scheduled capture boundary

Phase 4A contains an automation runner and user-scoped schedule records, but it
does not provision or activate a scheduler. The Sites deployment remains
manual until an external control-plane operator installs a real Cron Trigger.
There is no public HTTP cron endpoint.

Schedule management is a browser action protected by the platform-authenticated
user ID, exact same-origin checks, an explicit intent header, strict JSON/body
validation, and optimistic revision checks. A caller cannot supply another
owner ID, account partition, timezone, local time, weekday list, upstream URL,
or financial payload. Demo and Direct modes reject schedule enablement before
D1 or upstream portfolio access.

The Worker scheduled handler accepts only the fixed weekday slot: 07:10
`Asia/Seoul`, represented by 22:10 UTC on the previous day. All other scheduled
times return before account resolution, D1 access, or network access. A valid
run resolves the configured relay account, reads only enabled schedules for
that account, and uses an owner/account/slot-derived run ID plus a deterministic
snapshot idempotency key. D1 uniqueness and a short execution lease prevent an
overlapping or repeated invocation from creating a second snapshot. An existing
snapshot is checked before the relay is called.

Run records contain status, timestamps, attempt count, snapshot ID, and a
bounded error code. They must never store an exception message, credential,
authorization header, account number, relay payload, or raw Toss response.
Scheduled capture never imports from or writes to the cash-flow ledger.

The target time is not an exact execution guarantee and is not a universal
market-close valuation for a portfolio containing both Korean and US assets.
US daylight-saving changes and overlapping sessions make it a consistent
point-in-time target only. A missed snapshot cannot be reconstructed later from
the current-state Toss APIs. Periodic snapshots and manually complete external
cash flows improve Modified Dietz estimates but do not create true TWR.

## Automation provisioning checklist

Before enabling production automation, an operator must:

1. Run one Direct-mode relay process behind TLS on a stable public egress IP.
   On Fly, use `fly deploy --ha=false`, enforce `fly scale count 1`, and verify
   the result with `fly scale show`; `min_machines_running = 1` is not a maximum.
2. Register that egress IP in Toss WTS and apply a least-privilege firewall.
3. Store Toss credentials and `LEDGERLENS_RELAY_SHARED_TOKEN` only as encrypted
   fixed-host runtime secrets.
4. Store `TOSS_RELAY_URL` and `TOSS_RELAY_TOKEN` only as hosted runtime secrets;
   keep the matching opaque account reference server-only.
5. If Toss returns multiple brokerage accounts, configure `TOSS_ACCOUNT_SEQ`;
   then verify the live relay contract, intended masked account, and
   account-reference binding.
6. Install the external Cloudflare Cron expression `10 22 * * SUN-THU` (UTC). Sites
   does not declare this trigger in `.openai/hosting.json`.
7. Confirm the first observed trigger and successful snapshot in the dashboard.

Merely saving an enabled schedule record is not evidence that the platform
trigger exists. Product copy must distinguish requested, observed, succeeded,
and degraded states. Even after verification, `scheduled` is a liveness state:
the last canonical trigger observation must be no older than 96 hours and no
more than one minute in the future. Stale, malformed, or implausibly future
observations are reported as `degraded` so a removed Cron cannot appear active.

## Production access

Any hosted live-data shell must be deployed as an owner-only private site.
This repository alone is not evidence that such a deployment or authentication
boundary exists. Non-loopback live and relay reads are fail-closed unless
`LEDGERLENS_TRUST_PLATFORM_AUTH=true` and the trusted platform injects
`oai-authenticated-user-id`. The flag acknowledges an authentication boundary;
it is not authentication by itself.

Only enable it when the hosting layer strips caller-supplied identity headers
and injects the verified owner identity. A generic public host cannot trust a
browser-supplied header. If LedgerLens is hosted elsewhere, put both the page
and every API behind server-side authentication or a reverse proxy with the
same strip-and-inject contract. Client-side hiding is not access control.

Public GitHub demos must remain in Demo mode without Toss or relay secrets.
Loopback Direct mode requires the separate
`LEDGERLENS_ALLOW_LOCAL_HISTORY=true` opt-in and does not relax non-loopback
access.
