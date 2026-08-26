# Contributing

LedgerLens is a read-only personal capital-review workspace. Contributions must
preserve exact financial values, explicit data provenance, and the separation
between registered assets and investment performance.

## Before opening a pull request

1. Use Node.js `>=22.13.0` and install with `npm ci`.
2. Keep Toss credentials and personal data out of source, fixtures, screenshots,
   logs, and issue text. Use Demo data only.
3. Keep API routes thin and put validation, storage, and calculations in `lib/`.
4. Do not add order execution, an arbitrary upstream proxy, fabricated market
   data, or unsupported return attribution.
5. Add deterministic regression coverage that requires no live credentials,
   production D1 data, deployed relay, or Cron trigger.
6. Run `npm run lint` and `npm test`.

Pull requests should describe behavior and security impact, identify migrations
or environment changes, and include only Demo-mode screenshots. Do not use
`git add .` without reviewing every file. Report vulnerabilities through the
private process in `SECURITY.md`, not a public issue.

By contributing, you agree that your contribution will be licensed under the
repository's MIT License. Keep pull requests focused and document behavior,
security impact, migrations, environment changes, and Demo-only visual evidence.
