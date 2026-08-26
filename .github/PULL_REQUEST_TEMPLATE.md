## What changed

Describe the user-visible behavior and why this is the smallest appropriate change.

## Security and financial-truth impact

- Does this change touch credentials, identity, storage, relay, deployment, or API boundaries?
- Does it change any valuation, cash-flow, return, or data-quality calculation?
- Confirm that it adds no order execution or arbitrary upstream proxy.

## Verification

- [ ] `npm run audit:security`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `git diff --check`
- [ ] New behavior has deterministic regression coverage where appropriate.
- [ ] UI changes were checked in light, dark, desktop, mobile, and keyboard flows where applicable.

## Public-data safety

- [ ] This PR contains no real credential, token, account number, portfolio export, database, or live-account screenshot.
- [ ] Screenshots and fixtures are Demo-only and unmistakably fictional.
- [ ] Environment, migration, and deployment changes are documented.
