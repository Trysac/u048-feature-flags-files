# Project record: feature-flags-files

## Objective

Provide a dependency-free, pure TypeScript library that validates a versioned JSON flag file and evaluates feature flags locally with typed variants, segment rules and sticky FNV-1a percentage rollouts, returning OpenFeature-style evaluation reasons and error codes. It is intended for small teams that want feature flags without a SaaS account or a running flag server.

## Scope

In scope:

- The public API documented in the README: `parseFlags`, `parseFlagsJson`, `evaluate`, `bucket`, `fnv1a32`, `FlagConfigError` and the exported types.
- Validation of flag files with path-addressed issues.
- Local evaluation of targeting rules, segments and sticky rollouts.

Out of scope:

- Remote fetching of flag files.
- File watching or live reload.
- Analytics or exposure tracking.
- An OpenFeature provider. The reasons and error codes are compatible so a provider can wrap the library later.

## Timeline

| Date | Milestone |
|---|---|
| 2026 | Repository created from the factory utility template. |

## Effort metrics

Measured values only. Leave "pending measurement" until a real figure is recorded; never estimate here.

| Metric | Value | Source |
|---|---|---|
| Tokens (input / output) | 249894 / 91779 | factory ledger |
| Hours (human) | pending measurement | time log |
| Cost (USD) | 0.6044 | factory ledger |

## Factory run u048 (measured from API usage)

| Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|
| generation | claude-sonnet-5-5 | yes | 2705 | 78708 | 0 | 4473 | 0.3967 |
| fix-1 | claude-sonnet-5-5 | no | 10 | 2078 | 8470 | 73224 | 0.0493 |
| audit | claude-sonnet-5-5 | no | 10 | 2704 | 27077 | 89959 | 0.1037 |
| fix-2 | claude-sonnet-5-5 | no | 6 | 2190 | 8701 | 41129 | 0.0478 |
| docs | claude-haiku-5-5 | no | 38378 | 6099 | 0 | 0 | 0.0069 |

Total: $0.6044. Prices: Anthropic list prices.
