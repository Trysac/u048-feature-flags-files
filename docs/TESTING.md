# Testing

## Tools

- [Vitest](https://vitest.dev/) runs the suite in `test/`.
- Coverage is collected with V8 (`@vitest/coverage-v8`) over `src/`.

## Commands

```sh
npm test            # vitest run --coverage
npx vitest          # watch mode while developing
npm run check       # every gate, including tests
```

## Test files

- `test/index.test.ts` is the only suite. It imports the public entry point `src/index.ts` and covers:
  - hashing: FNV-1a reference vectors, raw byte input, and `bucket` determinism and range;
  - `FlagConfigError`: code, name, issue cap of 100, message and path length limits;
  - `parseFlags` and `parseFlagsJson`: a reference invalid file with several issues, segment cycles, a table of invalid inputs by path, normalization without input mutation, and prototype-looking keys;
  - parser limits: text length of 1,000,000 characters, invalid JSON, flag count of 1000, rule count of 100, condition depth of 16, condition node limit, and the 100-issue cap;
  - evaluation ordering and reasons: first match wins, `SPLIT`, `DEFAULT` without `ruleIndex`, catch-all rules;
  - operators: each operator with hit and miss cases, including semver and numeric string edge cases, and `all` and `any` combinations;
  - segments: nested references, `segment` with `when` on one rule, and segment references inside `when`;
  - rollouts: exact 5010/4990 split over 10,000 keys, stickiness, `salt` and `bucketBy`, unusable bucket attributes, prototype attributes, weight 0 and single-bucket rollouts;
  - runtime safety: missing and prototype attributes, oversized attribute strings, and invalid runtime operands.

## Rules

- Coverage must stay at or above 80 % for lines, branches, functions and statements (`vitest.config.ts`). Lowering the thresholds is not allowed.
- Test through the public entry point (`src/index.ts`) and assert observable behavior: return values, thrown errors and their messages.
- Each bug fix adds a test that fails without the fix.
- Tests are deterministic: no network, no real clock or randomness, no shared state between tests.

## Reports

Coverage reports are written to `coverage/` (text summary and `lcov`). The folder is ignored by git.
