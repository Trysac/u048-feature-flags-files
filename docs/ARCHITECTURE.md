# Architecture

## Overview

`@trysac/feature-flags-files` is a small, dependency-free TypeScript library published to npm as ES modules with type declarations. It validates a versioned JSON flag file and evaluates feature flags locally, with typed variants, segment rules and sticky FNV-1a percentage rollouts, returning OpenFeature-style reasons.

## Modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | Public API. Parsing and validation, evaluation, hashing and the `FlagConfigError` class are all implemented and exported from here. |

Add a row when you add a module. Internal modules are not re-exported unless they are part of the public API.

## Boundaries

- No runtime dependencies; any addition is justified in [STACK.md](STACK.md).
- No I/O, clock or randomness in the module. Evaluation is pure.
- Invalid flag files raise `FlagConfigError`. Evaluation never throws and reports errors through `Evaluation.reason` and `errorCode`.

## Build and distribution

`npm run build` compiles `src/` to `dist/` with `tsconfig.build.json`. Only `dist/` is published (`files` in `package.json`).

## Decisions

Architectural decisions are recorded in [decisions/](decisions/), starting with [0001](decisions/0001-record-architecture-decisions.md).
