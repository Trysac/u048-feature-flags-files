# Pure local evaluation of a validated JSON flag file with FNV-1a sticky rollouts

Status: accepted (generated, pending human review)

## Context

Small teams want gradual rollouts and segments without a flag server or SaaS account. Rollouts must be sticky per user and reproducible across languages, and the library has to run in browsers, Node, Deno and workers. Flag files are untrusted input, so size, depth and entry limits are needed.

## Decision

The library is one dependency-free module with no I/O, clock, randomness or node: imports. Callers load the file themselves and pass it to parseFlags or parseFlagsJson, which validate it, report path-addressed issues in a FlagConfigError (code invalid_config, at most 100 issues) and return a normalized copy built with null-prototype records. evaluate() is a pure function that never throws and returns OpenFeature-style reasons and error codes. Rollouts hash utf8(seed + ':' + id) with FNV-1a 32-bit via Math.imul, take it modulo 10000 and pick the first variant whose cumulative weight * 100 exceeds the bucket; the modulo bias of 2^32 mod 10000 is negligible. Segment cycles are rejected at parse time and guarded at runtime, and segment results are memoised per evaluation so shared segments cannot cause exponential work. Attribute lookup uses Object.hasOwn and refuses __proto__, constructor and prototype.

## Consequences

Evaluation behaves the same in every JavaScript runtime and bucket assignments are stable across versions, so other languages can reproduce them. An OpenFeature provider can wrap evaluate() later. Fetching, watching and analytics are left to callers. The explicit limits (100 segments, 100 variants, 100,000 condition nodes and others) reject unusually large files, and the parser ignores unknown properties, so typos in optional property names are not reported.
