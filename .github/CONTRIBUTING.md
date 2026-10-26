# Contributing

Thanks for your interest in improving Pilot.

## Getting Started
1. Fork the repo and branch from `main`: `git checkout -b feat/your-feature`
2. Install dependencies (Node 22 or newer): `npm ci`
3. Run the tests: `npm test`. They need no key and send nothing to the chain.
4. Optional: see `.env.example` for the variables the server reads. Live runs use a
   testnet burner key only; never commit a key.

## Before You Open a PR
- `npm test` passes and `npm audit --omit=dev --audit-level=high` is clean.
- Add or update tests for any behavior change. A refusal rule needs a test that
  names the rule it covers.
- Keep commits conventional: `feat:`, `fix:`, `perf:`, `docs:`, `test:`, `chore:`,
  `ci:`, `refactor:`. Releases are cut from these prefixes (`feat` bumps minor,
  `fix` and `perf` bump patch, `feat!:` or a `BREAKING CHANGE:` footer bumps major).

## Reporting Bugs / Requesting Features
Open an issue using the provided templates. Include repro steps, expected vs.
actual behavior, and your Node and MCP client versions.
