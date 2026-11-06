# Security practices

How this repository keeps the package and its users safe. The disclosure policy is in [../SECURITY.md](../SECURITY.md).

## Threat model

Defended:

- Prototype pollution through keys: parsed records use `Object.create(null)`, attribute lookup uses `Object.hasOwn`, and the attribute names `__proto__`, `constructor` and `prototype` never match a condition or bucket a rollout.
- Oversized or deeply nested input: text is capped at 1,000,000 characters, condition depth at 16, condition nodes at 100,000, variant value depth at 32, and context string attributes at 100,000 characters.
- Cyclic segment references: rejected at parse time with a `segment cycle` issue, and guarded at runtime by a visiting set that treats a re-entered segment as non-matching.
- Error leakage: config error messages are truncated to 200 characters.
- Runtime exceptions: `evaluate` catches all errors and returns the fallback with reason `ERROR`.
- Input mutation: `parseFlags` never mutates its input; the returned variant values are frozen copies.

Not defended:

- Flag files are trusted configuration. The library does not authenticate or sign them; whoever can write the file controls the flags.
- Rollouts are not a security boundary. FNV-1a is a non-cryptographic hash and bucket assignment can be predicted from a known seed and identifier.
- Context values are not sanitized. The library compares them and does not escape them for any output format.
- Timing and resource use are not bounded beyond the listed size limits; a file within the limits can still contain up to 100,000 condition nodes.
- Callers that pass user-controlled text to `parseFlagsJson` remain responsible for reading the file safely.

## Secrets

- No secrets, tokens or credentials in the repository, commit history, logs or prompts.
- `gitleaks` runs as the last step of `npm run check` and as a dedicated CI job. Its configuration is `.gitleaks.toml`.
- Publishing credentials live only in the CI secret store or the maintainer's local npm configuration.

## Dependencies

- The package has no runtime dependencies. Development dependencies are limited to the toolchain listed in [STACK.md](STACK.md).
- Dependabot opens weekly updates for npm packages and GitHub Actions.
- Commit the generated `package-lock.json` so installs are reproducible.

## Code

- Evaluation has no `eval`, dynamic `Function` construction, I/O or `node:` imports.
- Inputs from callers are validated and rejected with `FlagConfigError` carrying path-addressed issues.

## Publishing

- Packages are published from a clean checkout after `npm run check` passes.
- Only `dist/` is included in the published tarball.
