# feature-flags-files

[![npm version](https://img.shields.io/npm/v/@trysac/feature-flags-files.svg)](https://www.npmjs.com/package/@trysac/feature-flags-files)
[![license: MIT](https://img.shields.io/npm/l/@trysac/feature-flags-files.svg)](LICENSE)
[![CI](https://github.com/Trysac/u048-feature-flags-files/actions/workflows/ci.yml/badge.svg)](https://github.com/Trysac/u048-feature-flags-files/actions/workflows/ci.yml)

Feature flags from a versioned JSON file with typed variants, segment rules and sticky FNV-1a percentage rollouts, evaluated locally with OpenFeature-style reasons.

## Problem

Small teams want feature flags without a SaaS account or a running flag server, but hand-rolled `if` statements cannot do gradual rollouts or segments, and rollouts must be sticky per user and reproducible across languages. This library validates a versioned JSON flag file and evaluates flags with segments and hashed rollouts, purely and in any JavaScript runtime (no I/O, no clock, no randomness, no `node:` imports in evaluation).

## Install

```sh
npm install @trysac/feature-flags-files
```

The package ships ES modules with TypeScript declarations. The README examples assume Node.js 20 or newer.

## Usage

```ts
import { readFile } from "node:fs/promises";
import { evaluate, parseFlagsJson } from "@trysac/feature-flags-files";

const file = parseFlagsJson(await readFile("flags.json", "utf8"));
const result = evaluate(file, "beta", { key: "user-1", plan: "pro" }, false);
console.log(result.value, result.variant, result.reason);
```

Example file:

```json
{
  "version": 1,
  "segments": { "beta-users": { "attr": "plan", "op": "eq", "value": "beta" } },
  "flags": {
    "beta": {
      "enabled": true,
      "variants": { "on": true, "off": false },
      "default": "off",
      "rules": [
        { "segment": "beta-users", "serve": { "variant": "on" } },
        { "serve": { "rollout": [{ "variant": "on", "weight": 50 }, { "variant": "off", "weight": 50 }] } }
      ]
    }
  }
}
```

## API

| Export | Signature | Description |
|---|---|---|
| `parseFlags` | `(input: unknown) => FlagFile` | Validates a parsed object; throws `FlagConfigError` listing every issue found (at most 100). |
| `parseFlagsJson` | `(text: string) => FlagFile` | Rejects text longer than 1,000,000 characters, parses JSON, then validates it. |
| `evaluate` | `(file, flagKey, ctx, fallback) => Evaluation<T>` | Pure local evaluation; never throws. |
| `bucket` | `(seed: string, id: string) => number` | `fnv1a32(utf8(seed + ":" + id)) % 10000`, returns 0 to 9999. |
| `fnv1a32` | `(bytes: Uint8Array) => number` | Unsigned 32-bit FNV-1a hash. |
| `FlagConfigError` | `class extends Error` | `code: 'invalid_config'` and `issues: { path, message }[]` (at most 100). |

Rules are evaluated in order and the first match wins. A rule without `segment` and `when` matches everything. Conditions are `{ all }`, `{ any }`, `{ segment }` or `{ attr, op, value }` with operators `eq`, `neq`, `in`, `notIn`, `gt`, `lt`, `contains`, `startsWith` and `semverGte`. A rollout buckets the `bucketBy` attribute (default `key`) with seed `salt ?? flagKey`; weights are integers from 0 to 100 summing to 100. A rollout whose bucketing attribute is missing or not a string or finite number does not match, and evaluation continues.

### Reasons and error codes

Reasons: `DISABLED`, `TARGETING_MATCH` (fixed variant, with `ruleIndex`), `SPLIT` (rollout, with `ruleIndex`), `DEFAULT`, `ERROR`. Error codes: `FLAG_NOT_FOUND` (returns the fallback) and `TYPE_MISMATCH` (the variant type differs from the fallback type; returns the fallback).

### Limits

Text up to 1,000,000 characters, 1000 flags, 100 rules per flag, condition nesting depth 16, 100 segments, 100 variants per flag, 100 rollout entries, 100 children per `all` or `any`, 1000 items in an `in` or `notIn` list, and 100,000 condition nodes per file. Context attribute strings longer than 100,000 characters are treated as absent.

### Modulo bias

Buckets use `hash % 10000`. Since 2^32 is not a multiple of 10000 the bias is negligible. Hashing is stable across versions.

### Why not Unleash or LaunchDarkly

Unleash and LaunchDarkly need a server or an account. This library reads a local file and evaluates it in-process.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and limits.

## Development

```sh
npm install
npm run check   # lint, format, types, tests with coverage, docs, secrets
```

See [AGENTS.md](AGENTS.md) for the full command list and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[MIT](LICENSE) © 2026 Miguel Gomez
