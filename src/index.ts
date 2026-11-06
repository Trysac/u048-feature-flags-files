/**
 * Local feature flags from a versioned JSON file: typed variants, segments and
 * sticky FNV-1a percentage rollouts, with OpenFeature-style evaluation details.
 *
 * Evaluation is pure (no I/O, clock, randomness or Node imports), so the module
 * runs in browsers, Node, Deno and workers.
 *
 * @packageDocumentation
 */

/** A variant value: boolean, string, number or a JSON object. */
export type Value = boolean | string | number | Record<string, unknown>;

/** Comparison operators usable in an attribute condition. */
export type Operator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "gt"
  | "lt"
  | "contains"
  | "startsWith"
  | "semverGte";

/** A targeting condition. */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { segment: string }
  | { attr: string; op: Operator; value: unknown };

/** One share of a percentage rollout. */
export interface RolloutEntry {
  variant: string;
  weight: number;
}

/** Serve a fixed variant. */
export interface VariantServe {
  variant: string;
}

/** Serve a variant chosen by a sticky hash bucket. */
export interface RolloutServe {
  rollout: RolloutEntry[];
  bucketBy?: string;
  salt?: string;
}

/** What a matching rule serves. */
export type Serve = VariantServe | RolloutServe;

/** A targeting rule. Without `segment` and `when` it matches everything. */
export interface Rule {
  segment?: string;
  when?: Condition;
  serve: Serve;
}

/** A flag definition. */
export interface FlagDef {
  enabled: boolean;
  variants: Record<string, Value>;
  default: string;
  off?: string;
  rules?: Rule[];
}

/** A parsed flag file. */
export interface FlagFile {
  version: 1;
  segments?: Record<string, Condition>;
  flags: Record<string, FlagDef>;
}

/** The evaluation context: a stable key plus arbitrary attributes. */
export interface EvaluationContext {
  key: string;
  [attr: string]: unknown;
}

/** Why a value was returned (OpenFeature reasons). */
export type Reason = "DISABLED" | "TARGETING_MATCH" | "SPLIT" | "DEFAULT" | "ERROR";

/** Error codes (OpenFeature error codes). */
export type ErrorCode = "FLAG_NOT_FOUND" | "TYPE_MISMATCH";

/** The result of evaluating one flag. */
export interface Evaluation<T> {
  value: T;
  variant: string | null;
  reason: Reason;
  errorCode?: ErrorCode;
  ruleIndex?: number;
}

/** One validation problem, addressed by a JSONPath-like path. */
export interface ConfigIssue {
  path: string;
  message: string;
}

/** Size and depth limits enforced by the parser and the evaluator. */
export const LIMITS = Object.freeze({
  maxTextLength: 1_000_000,
  maxFlags: 1000,
  maxRules: 100,
  maxConditionDepth: 16,
  maxIssues: 100,
  maxSegments: 100,
  maxVariants: 100,
  maxRolloutEntries: 100,
  maxConditionChildren: 100,
  maxListItems: 1000,
  maxConditionNodes: 100_000,
  maxValueDepth: 32,
  maxAttributeLength: 100_000,
});

const MAX_MESSAGE = 200;
const BUCKETS = 10_000;
const OPERATORS: readonly Operator[] = [
  "eq",
  "neq",
  "in",
  "notIn",
  "gt",
  "lt",
  "contains",
  "startsWith",
  "semverGte",
];
const CONDITION_KEYS: readonly string[] = ["all", "any", "segment", "attr"];
const UNSAFE_ATTRIBUTES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const NUMERIC = /^-?[0-9]+([.][0-9]+)?$/;
const SEMVER = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/;
const INVALID: unique symbol = Symbol("invalid");
const encoder = new TextEncoder();

function summarize(issues: readonly ConfigIssue[]): string {
  const first = issues[0];
  const head =
    first === undefined
      ? "invalid flag file"
      : `invalid flag file: ${first.path}: ${first.message}`;
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return `${head}${more}`.slice(0, MAX_MESSAGE);
}

/** Thrown when a flag file is invalid. Lists at most 100 issues. */
export class FlagConfigError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "invalid_config" as const;
  /** The problems found, at most 100. */
  readonly issues: readonly ConfigIssue[];

  /**
   * @param issues - The problems found; only the first 100 are kept.
   */
  constructor(issues: readonly ConfigIssue[]) {
    const listed = issues
      .slice(0, LIMITS.maxIssues)
      .map((issue) => Object.freeze({ path: issue.path, message: issue.message }));
    super(summarize(listed));
    this.name = "FlagConfigError";
    this.issues = listed;
  }
}

/**
 * FNV-1a 32-bit hash.
 *
 * @param bytes - The bytes to hash.
 * @returns The unsigned 32-bit hash.
 */
export function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Sticky bucket of an id: `fnv1a32(utf8(seed + ":" + id)) % 10000`.
 * The modulo bias of 2^32 mod 10000 is negligible.
 *
 * @param seed - The rollout seed (the salt or the flag key).
 * @param id - The bucketing identifier.
 * @returns An integer from 0 to 9999.
 */
export function bucket(seed: string, id: string): number {
  return fnv1a32(encoder.encode(`${seed}:${id}`)) % BUCKETS;
}

// ---------------------------------------------------------------- parsing --

interface ParseState {
  readonly issues: ConfigIssue[];
  nodes: number;
  segmentNames: Set<string>;
  refs: Set<string> | null;
}

function add(state: ParseState, path: string, message: string): void {
  if (state.issues.length < LIMITS.maxIssues) {
    state.issues.push({ path, message: message.slice(0, MAX_MESSAGE) });
  }
}

function clip(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isOperator(value: string): value is Operator {
  return (OPERATORS as readonly string[]).includes(value);
}

function toNumeric(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && NUMERIC.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseSemver(value: unknown): [number, number, number] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = SEMVER.exec(value);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function cloneJson(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID;
  }
  if (depth >= LIMITS.maxValueDepth) {
    return INVALID;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const copy = cloneJson(item, depth + 1);
      if (copy === INVALID) {
        return INVALID;
      }
      items.push(copy);
    }
    return Object.freeze(items);
  }
  if (isPlainObject(value)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const copy = cloneJson(value[key], depth + 1);
      if (copy === INVALID) {
        return INVALID;
      }
      out[key] = copy;
    }
    return Object.freeze(out);
  }
  return INVALID;
}

function parseVariantValue(raw: unknown): Value | undefined {
  if (typeof raw === "boolean" || typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (isPlainObject(raw)) {
    const copy = cloneJson(raw, 0);
    return copy === INVALID ? undefined : (copy as Record<string, unknown>);
  }
  return undefined;
}

function operandProblem(op: Operator, value: unknown): string | undefined {
  switch (op) {
    case "eq":
    case "neq":
      return isPrimitive(value) ? undefined : "value must be a string, number, boolean or null";
    case "in":
    case "notIn":
      return Array.isArray(value) && value.length <= LIMITS.maxListItems && value.every(isPrimitive)
        ? undefined
        : `value must be an array of at most ${LIMITS.maxListItems} primitives`;
    case "gt":
    case "lt":
      return toNumeric(value) === undefined
        ? "value must be a finite number or a numeric string"
        : undefined;
    case "contains":
    case "startsWith":
      return typeof value === "string" ? undefined : "value must be a string";
    default:
      return parseSemver(value) === undefined
        ? "value must be a semantic version such as 1.2.3"
        : undefined;
  }
}

function parseCondition(
  raw: unknown,
  path: string,
  depth: number,
  state: ParseState,
): Condition | undefined {
  if (depth > LIMITS.maxConditionDepth) {
    add(state, path, `conditions nested deeper than ${LIMITS.maxConditionDepth}`);
    return undefined;
  }
  state.nodes += 1;
  if (state.nodes > LIMITS.maxConditionNodes) {
    add(state, path, `more than ${LIMITS.maxConditionNodes} conditions in the file`);
    return undefined;
  }
  if (!isPlainObject(raw)) {
    add(state, path, "condition must be an object");
    return undefined;
  }
  const present = CONDITION_KEYS.filter((key) => Object.hasOwn(raw, key));
  const kind = present[0];
  if (present.length !== 1 || kind === undefined) {
    add(state, path, "condition must have exactly one of all, any, segment or attr");
    return undefined;
  }
  if (kind === "all" || kind === "any") {
    const list = get(raw, kind);
    if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.maxConditionChildren) {
      add(
        state,
        `${path}.${kind}`,
        `${kind} must be an array of 1 to ${LIMITS.maxConditionChildren} conditions`,
      );
      return undefined;
    }
    const children: Condition[] = [];
    let ok = true;
    for (let index = 0; index < list.length; index += 1) {
      const child = parseCondition(list[index], `${path}.${kind}[${index}]`, depth + 1, state);
      if (child === undefined) {
        ok = false;
      } else {
        children.push(child);
      }
    }
    if (!ok) {
      return undefined;
    }
    return kind === "all" ? { all: children } : { any: children };
  }
  if (kind === "segment") {
    const name = get(raw, "segment");
    if (typeof name !== "string") {
      add(state, `${path}.segment`, "segment must be a string");
      return undefined;
    }
    if (!state.segmentNames.has(name)) {
      add(state, `${path}.segment`, `unknown segment "${clip(name)}"`);
      return undefined;
    }
    state.refs?.add(name);
    return { segment: name };
  }
  const attr = get(raw, "attr");
  const op = get(raw, "op");
  const attrOk = typeof attr === "string" && attr !== "";
  if (!attrOk) {
    add(state, `${path}.attr`, "attr must be a non-empty string");
  }
  if (typeof op !== "string" || !isOperator(op)) {
    add(state, `${path}.op`, `op must be one of ${OPERATORS.join(", ")}`);
    return undefined;
  }
  if (!Object.hasOwn(raw, "value")) {
    add(state, `${path}.value`, "value is required");
    return undefined;
  }
  const value = get(raw, "value");
  const problem = operandProblem(op, value);
  if (problem !== undefined) {
    add(state, `${path}.value`, problem);
    return undefined;
  }
  if (!attrOk) {
    return undefined;
  }
  const operand = Array.isArray(value) ? [...value] : value;
  return { attr: attr as string, op, value: operand };
}

function unknownVariant(name: unknown): string {
  return typeof name === "string" ? `unknown variant "${clip(name)}"` : "variant must be a string";
}

function parseRollout(
  raw: Record<string, unknown>,
  path: string,
  variants: ReadonlySet<string>,
  state: ParseState,
): RolloutServe | undefined {
  const list = get(raw, "rollout");
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.maxRolloutEntries) {
    add(
      state,
      `${path}.rollout`,
      `rollout must be an array of 1 to ${LIMITS.maxRolloutEntries} entries`,
    );
    return undefined;
  }
  const entries: RolloutEntry[] = [];
  let total = 0;
  let ok = true;
  for (let index = 0; index < list.length; index += 1) {
    const entryPath = `${path}.rollout[${index}]`;
    const entry: unknown = list[index];
    if (!isPlainObject(entry)) {
      add(state, entryPath, "rollout entry must be an object");
      ok = false;
      continue;
    }
    const variant = get(entry, "variant");
    const weight = get(entry, "weight");
    const variantOk = typeof variant === "string" && variants.has(variant);
    const weightOk =
      typeof weight === "number" && Number.isInteger(weight) && weight >= 0 && weight <= 100;
    if (!variantOk) {
      add(state, `${entryPath}.variant`, unknownVariant(variant));
    }
    if (!weightOk) {
      add(state, `${entryPath}.weight`, "weight must be an integer from 0 to 100");
    }
    if (variantOk && weightOk) {
      entries.push({ variant: variant as string, weight: weight as number });
      total += weight as number;
    } else {
      ok = false;
    }
  }
  if (ok && total !== 100) {
    add(state, `${path}.rollout`, `weights must sum to 100, got ${total}`);
    ok = false;
  }
  const bucketBy = get(raw, "bucketBy");
  if (bucketBy !== undefined && (typeof bucketBy !== "string" || bucketBy === "")) {
    add(state, `${path}.bucketBy`, "bucketBy must be a non-empty string");
    ok = false;
  }
  const salt = get(raw, "salt");
  if (salt !== undefined && typeof salt !== "string") {
    add(state, `${path}.salt`, "salt must be a string");
    ok = false;
  }
  if (!ok) {
    return undefined;
  }
  return {
    rollout: entries,
    ...(bucketBy === undefined ? {} : { bucketBy: bucketBy as string }),
    ...(salt === undefined ? {} : { salt: salt as string }),
  };
}

function parseServe(
  raw: unknown,
  path: string,
  variants: ReadonlySet<string>,
  state: ParseState,
): Serve | undefined {
  if (!isPlainObject(raw)) {
    add(state, path, "serve must be an object");
    return undefined;
  }
  const hasVariant = Object.hasOwn(raw, "variant");
  if (hasVariant === Object.hasOwn(raw, "rollout")) {
    add(state, path, "serve must have exactly one of variant or rollout");
    return undefined;
  }
  if (hasVariant) {
    const variant = get(raw, "variant");
    if (typeof variant !== "string" || !variants.has(variant)) {
      add(state, `${path}.variant`, unknownVariant(variant));
      return undefined;
    }
    return { variant };
  }
  return parseRollout(raw, path, variants, state);
}

function parseRule(
  raw: unknown,
  path: string,
  variants: ReadonlySet<string>,
  state: ParseState,
): Rule | undefined {
  if (!isPlainObject(raw)) {
    add(state, path, "rule must be an object");
    return undefined;
  }
  let ok = true;
  const segmentRaw = get(raw, "segment");
  let segment: string | undefined;
  if (segmentRaw !== undefined) {
    if (typeof segmentRaw !== "string") {
      add(state, `${path}.segment`, "segment must be a string");
      ok = false;
    } else if (!state.segmentNames.has(segmentRaw)) {
      add(state, `${path}.segment`, `unknown segment "${clip(segmentRaw)}"`);
      ok = false;
    } else {
      segment = segmentRaw;
    }
  }
  const whenRaw = get(raw, "when");
  let when: Condition | undefined;
  if (whenRaw !== undefined) {
    when = parseCondition(whenRaw, `${path}.when`, 1, state);
    if (when === undefined) {
      ok = false;
    }
  }
  const serve = parseServe(get(raw, "serve"), `${path}.serve`, variants, state);
  if (!ok || serve === undefined) {
    return undefined;
  }
  return {
    ...(segment === undefined ? {} : { segment }),
    ...(when === undefined ? {} : { when }),
    serve,
  };
}

function parseFlag(raw: unknown, path: string, state: ParseState): FlagDef | undefined {
  if (!isPlainObject(raw)) {
    add(state, path, "flag must be an object");
    return undefined;
  }
  let ok = true;
  const enabled = get(raw, "enabled");
  if (typeof enabled !== "boolean") {
    add(state, `${path}.enabled`, "enabled must be a boolean");
    ok = false;
  }
  const variantsRaw = get(raw, "variants");
  if (!isPlainObject(variantsRaw)) {
    add(state, `${path}.variants`, "variants must be an object");
    return undefined;
  }
  const names = Object.keys(variantsRaw);
  if (names.length < 1 || names.length > LIMITS.maxVariants) {
    add(state, `${path}.variants`, `variants must have 1 to ${LIMITS.maxVariants} entries`);
    return undefined;
  }
  const variants = Object.create(null) as Record<string, Value>;
  for (const name of names) {
    const value = parseVariantValue(variantsRaw[name]);
    if (value === undefined) {
      add(
        state,
        `${path}.variants.${clip(name)}`,
        "variant value must be a boolean, string, finite number or JSON object",
      );
      ok = false;
    } else {
      variants[name] = value;
    }
  }
  const known = new Set(names);
  const defaultName = get(raw, "default");
  if (typeof defaultName !== "string" || !known.has(defaultName)) {
    add(state, `${path}.default`, unknownVariant(defaultName));
    ok = false;
  }
  const offRaw = get(raw, "off");
  if (offRaw !== undefined && (typeof offRaw !== "string" || !known.has(offRaw))) {
    add(state, `${path}.off`, unknownVariant(offRaw));
    ok = false;
  }
  const rulesRaw = get(raw, "rules");
  let rules: Rule[] | undefined;
  if (rulesRaw !== undefined) {
    if (!Array.isArray(rulesRaw) || rulesRaw.length > LIMITS.maxRules) {
      add(state, `${path}.rules`, `rules must be an array of at most ${LIMITS.maxRules} rules`);
      ok = false;
    } else {
      const parsed: Rule[] = [];
      for (let index = 0; index < rulesRaw.length; index += 1) {
        const rule = parseRule(rulesRaw[index], `${path}.rules[${index}]`, known, state);
        if (rule === undefined) {
          ok = false;
        } else {
          parsed.push(rule);
        }
      }
      rules = parsed;
    }
  }
  if (!ok) {
    return undefined;
  }
  return {
    enabled: enabled as boolean,
    variants,
    default: defaultName as string,
    ...(offRaw === undefined ? {} : { off: offRaw as string }),
    ...(rules === undefined ? {} : { rules }),
  };
}

function detectCycles(
  names: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  state: ParseState,
): void {
  const marks = new Map<string, number>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    marks.set(name, 1);
    stack.push(name);
    for (const next of edges.get(name) ?? []) {
      const mark = marks.get(next);
      if (mark === 1) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        add(
          state,
          `$.segments.${clip(next)}`,
          `segment cycle: ${cycle.map((item) => clip(item, 32)).join(" -> ")}`,
        );
      } else if (mark === undefined) {
        visit(next);
      }
    }
    stack.pop();
    marks.set(name, 2);
  };
  for (const name of names) {
    if (!marks.has(name)) {
      visit(name);
    }
  }
}

function parseFile(input: unknown, state: ParseState): FlagFile | undefined {
  if (!isPlainObject(input)) {
    add(state, "$", "flag file must be an object");
    return undefined;
  }
  if (get(input, "version") !== 1) {
    add(state, "$.version", "version must be 1");
  }
  const segmentsRaw = get(input, "segments");
  const segments = Object.create(null) as Record<string, Condition>;
  if (segmentsRaw !== undefined) {
    if (!isPlainObject(segmentsRaw)) {
      add(state, "$.segments", "segments must be an object");
    } else {
      const names = Object.keys(segmentsRaw);
      if (names.length > LIMITS.maxSegments) {
        add(state, "$.segments", `at most ${LIMITS.maxSegments} segments are allowed`);
      } else {
        const edges = new Map<string, Set<string>>();
        for (const name of names) {
          state.segmentNames.add(name);
        }
        for (const name of names) {
          const refs = new Set<string>();
          state.refs = refs;
          const condition = parseCondition(segmentsRaw[name], `$.segments.${clip(name)}`, 1, state);
          state.refs = null;
          if (condition !== undefined) {
            segments[name] = condition;
            edges.set(name, refs);
          }
        }
        detectCycles(names, edges, state);
      }
    }
  }
  const flagsRaw = get(input, "flags");
  const flags = Object.create(null) as Record<string, FlagDef>;
  if (!isPlainObject(flagsRaw)) {
    add(state, "$.flags", "flags must be an object");
  } else {
    const keys = Object.keys(flagsRaw);
    if (keys.length > LIMITS.maxFlags) {
      add(state, "$.flags", `at most ${LIMITS.maxFlags} flags are allowed`);
    } else {
      for (const key of keys) {
        const flag = parseFlag(flagsRaw[key], `$.flags.${clip(key)}`, state);
        if (flag !== undefined) {
          flags[key] = flag;
        }
      }
    }
  }
  if (state.issues.length > 0) {
    return undefined;
  }
  return {
    version: 1,
    ...(segmentsRaw === undefined ? {} : { segments }),
    flags,
  };
}

/**
 * Validates a decoded flag file and returns a normalized copy.
 * Unknown properties are ignored. The input is never mutated.
 *
 * @param input - The decoded JSON value.
 * @returns The parsed flag file.
 * @throws {FlagConfigError} With code `invalid_config` and at most 100 issues.
 */
export function parseFlags(input: unknown): FlagFile {
  const state: ParseState = {
    issues: [],
    nodes: 0,
    segmentNames: new Set(),
    refs: null,
  };
  const file = parseFile(input, state);
  if (file === undefined || state.issues.length > 0) {
    throw new FlagConfigError(state.issues);
  }
  return file;
}

/**
 * Parses JSON text (at most 1,000,000 characters) and validates it.
 *
 * @param text - The JSON text of a flag file.
 * @returns The parsed flag file.
 * @throws {FlagConfigError} When the text is too long, not JSON or invalid.
 */
export function parseFlagsJson(text: string): FlagFile {
  if (typeof text !== "string") {
    throw new FlagConfigError([{ path: "$", message: "input must be a string" }]);
  }
  if (text.length > LIMITS.maxTextLength) {
    throw new FlagConfigError([
      {
        path: "$",
        message: `text exceeds ${LIMITS.maxTextLength} characters`,
      },
    ]);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FlagConfigError([{ path: "$", message: "text is not valid JSON" }]);
  }
  return parseFlags(data);
}

// ------------------------------------------------------------- evaluation --

interface Runtime {
  readonly file: FlagFile;
  readonly ctx: EvaluationContext;
  readonly memo: Map<string, boolean>;
  readonly visiting: Set<string>;
}

function lookup(ctx: EvaluationContext, attr: string): unknown {
  if (UNSAFE_ATTRIBUTES.has(attr) || !Object.hasOwn(ctx, attr)) {
    return undefined;
  }
  const value = ctx[attr];
  if (typeof value === "string" && value.length > LIMITS.maxAttributeLength) {
    return undefined;
  }
  return value;
}

function semverGte(actual: unknown, expected: unknown): boolean {
  const left = parseSemver(actual);
  const right = parseSemver(expected);
  if (left === undefined || right === undefined) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

function compare(op: Operator, actual: unknown, expected: unknown): boolean {
  if (actual === undefined) {
    return false;
  }
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "notIn":
      return Array.isArray(expected) && !expected.includes(actual);
    case "gt":
    case "lt": {
      const left = toNumeric(actual);
      const right = toNumeric(expected);
      if (left === undefined || right === undefined) {
        return false;
      }
      return op === "gt" ? left > right : left < right;
    }
    case "contains":
      return (
        typeof actual === "string" && typeof expected === "string" && actual.includes(expected)
      );
    case "startsWith":
      return (
        typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected)
      );
    case "semverGte":
      return semverGte(actual, expected);
    default:
      return false;
  }
}

function segmentMatches(name: string, rt: Runtime): boolean {
  const known = rt.memo.get(name);
  if (known !== undefined) {
    return known;
  }
  const segments = rt.file.segments;
  if (segments === undefined || !Object.hasOwn(segments, name) || rt.visiting.has(name)) {
    return false;
  }
  rt.visiting.add(name);
  const result = conditionMatches(segments[name] as Condition, rt);
  rt.visiting.delete(name);
  rt.memo.set(name, result);
  return result;
}

function conditionMatches(condition: Condition, rt: Runtime): boolean {
  if ("all" in condition) {
    for (const child of condition.all) {
      if (!conditionMatches(child, rt)) {
        return false;
      }
    }
    return true;
  }
  if ("any" in condition) {
    for (const child of condition.any) {
      if (conditionMatches(child, rt)) {
        return true;
      }
    }
    return false;
  }
  if ("segment" in condition) {
    return segmentMatches(condition.segment, rt);
  }
  return compare(condition.op, lookup(rt.ctx, condition.attr), condition.value);
}

function ruleMatches(rule: Rule, rt: Runtime): boolean {
  if (rule.segment !== undefined && !segmentMatches(rule.segment, rt)) {
    return false;
  }
  return rule.when === undefined || conditionMatches(rule.when, rt);
}

function pickRollout(
  serve: RolloutServe,
  flagKey: string,
  ctx: EvaluationContext,
): string | undefined {
  const raw = lookup(ctx, serve.bucketBy ?? "key");
  let id: string;
  if (typeof raw === "string") {
    id = raw;
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    id = String(raw);
  } else {
    return undefined;
  }
  const position = bucket(serve.salt ?? flagKey, id);
  let cumulative = 0;
  for (const entry of serve.rollout) {
    cumulative += entry.weight;
    if (cumulative * 100 > position) {
      return entry.variant;
    }
  }
  return undefined;
}

function valueKind(value: unknown): string | undefined {
  if (typeof value === "object") {
    return value !== null && !Array.isArray(value) ? "object" : undefined;
  }
  return typeof value;
}

function resolve<T extends Value>(
  def: FlagDef,
  variant: string,
  reason: Reason,
  ruleIndex: number | undefined,
  fallback: T,
): Evaluation<T> {
  if (!Object.hasOwn(def.variants, variant)) {
    return { value: fallback, variant: null, reason: "ERROR" };
  }
  const value = def.variants[variant] as Value;
  const kind = valueKind(value);
  if (kind === undefined || kind !== valueKind(fallback)) {
    return {
      value: fallback,
      variant: null,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
    };
  }
  return {
    value: value as T,
    variant,
    reason,
    ...(ruleIndex === undefined ? {} : { ruleIndex }),
  };
}

function evaluateFlag<T extends Value>(
  file: FlagFile,
  flagKey: string,
  ctx: EvaluationContext,
  fallback: T,
): Evaluation<T> {
  if (!Object.hasOwn(file.flags, flagKey)) {
    return {
      value: fallback,
      variant: null,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    };
  }
  const def = file.flags[flagKey] as FlagDef;
  if (!def.enabled) {
    return resolve(def, def.off ?? def.default, "DISABLED", undefined, fallback);
  }
  const rt: Runtime = { file, ctx, memo: new Map(), visiting: new Set() };
  const rules = def.rules ?? [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index] as Rule;
    if (!ruleMatches(rule, rt)) {
      continue;
    }
    const serve = rule.serve;
    if ("variant" in serve) {
      return resolve(def, serve.variant, "TARGETING_MATCH", index, fallback);
    }
    const picked = pickRollout(serve, flagKey, ctx);
    if (picked !== undefined) {
      return resolve(def, picked, "SPLIT", index, fallback);
    }
  }
  return resolve(def, def.default, "DEFAULT", undefined, fallback);
}

/**
 * Evaluates one flag locally. Never throws.
 *
 * Rules run in order and the first match wins. A missing attribute, an
 * attribute named `__proto__`, `constructor` or `prototype`, or a string
 * attribute longer than 100,000 characters makes a condition false.
 *
 * @param file - A flag file returned by {@link parseFlags}.
 * @param flagKey - The flag to evaluate.
 * @param ctx - The evaluation context.
 * @param fallback - Returned on errors; its type must match the variant type.
 * @returns The value with its variant, reason and optional error code.
 */
export function evaluate<T extends Value>(
  file: FlagFile,
  flagKey: string,
  ctx: EvaluationContext,
  fallback: T,
): Evaluation<T> {
  try {
    return evaluateFlag(file, flagKey, ctx, fallback);
  } catch {
    return { value: fallback, variant: null, reason: "ERROR" };
  }
}
