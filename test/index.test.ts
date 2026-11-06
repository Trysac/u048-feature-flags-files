import { describe, expect, it } from "vitest";
import * as ff from "../src/index.js";

type FlagFile = ff.FlagFile;
type EvaluationContext = ff.EvaluationContext;
const { FlagConfigError, LIMITS, bucket, evaluate, fnv1a32, parseFlags, parseFlagsJson } = ff;

const okFlag = {
  enabled: true,
  variants: { on: true, off: false },
  default: "off",
};

function load(flags: Record<string, unknown>, segments?: Record<string, unknown>): FlagFile {
  return parseFlags({
    version: 1,
    ...(segments === undefined ? {} : { segments }),
    flags,
  });
}

function ctxOf(key: string, attrs: Record<string, unknown> = {}): EvaluationContext {
  return { ...attrs, key };
}

function configError(fn: () => unknown): ff.FlagConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FlagConfigError);
    return error as ff.FlagConfigError;
  }
  throw new Error("expected a FlagConfigError");
}

function pathsOf(input: unknown): string[] {
  return configError(() => parseFlags(input)).issues.map((issue) => issue.path);
}

function withFlag(patch: Record<string, unknown>): unknown {
  return { version: 1, flags: { f: { ...okFlag, ...patch } } };
}

function withRule(rule: unknown): unknown {
  return withFlag({ rules: [rule] });
}

function withWhen(when: unknown): unknown {
  return withRule({ when, serve: { variant: "on" } });
}

function withServe(serve: unknown): unknown {
  return withRule({ serve });
}

function matches(cond: unknown, attrs: Record<string, unknown>): boolean {
  const file = load({
    f: { ...okFlag, rules: [{ when: cond, serve: { variant: "on" } }] },
  });
  return evaluate<boolean>(file, "f", ctxOf("k", attrs), false).value;
}

function nest(depth: number): Record<string, unknown> {
  return depth <= 1 ? { attr: "a", op: "eq", value: 1 } : { all: [nest(depth - 1)] };
}

function deepObject(depth: number): unknown {
  let value: unknown = {};
  for (let i = 0; i < depth; i += 1) {
    value = { a: value };
  }
  return value;
}

function manyFlags(count: number, flag: unknown): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    flags[`f${i}`] = flag;
  }
  return flags;
}

function manySegments(count: number): Record<string, unknown> {
  const segments: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    segments[`s${i}`] = { attr: "a", op: "eq", value: i };
  }
  return segments;
}

describe("hashing", () => {
  const encoder = new TextEncoder();

  it("matches the FNV-1a reference vectors", () => {
    expect(fnv1a32(encoder.encode(""))).toBe(0x811c9dc5);
    expect(fnv1a32(encoder.encode("a"))).toBe(0xe40c292c);
    expect(fnv1a32(encoder.encode("foobar"))).toBe(0xbf9cf968);
  });

  it("hashes raw bytes and returns unsigned values", () => {
    expect(fnv1a32(Uint8Array.of(0xc3, 0xa9))).toBe(fnv1a32(encoder.encode("é")));
    expect(fnv1a32(encoder.encode("a"))).toBeGreaterThan(0x7fffffff);
  });

  it("buckets deterministically", () => {
    expect(bucket("beta", "user-1")).toBe(4142);
    expect(bucket("beta", "user-42")).toBe(2813);
    for (const id of ["", "x", "user-7", "é", "a:b"]) {
      expect(bucket("beta", id)).toBe(fnv1a32(encoder.encode(`beta:${id}`)) % 10000);
    }
  });

  it("keeps buckets inside 0..9999", () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = bucket("seed", `id-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10000);
    }
  });
});

describe("FlagConfigError", () => {
  it("carries a stable code and caps the issue list", () => {
    const issues = Array.from({ length: 150 }, (_, i) => ({
      path: `$.${i}`,
      message: "m",
    }));
    const error = new FlagConfigError(issues);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FlagConfigError");
    expect(error.code).toBe("invalid_config");
    expect(error.issues).toHaveLength(100);
    expect(error.message).toContain("+99 more");
  });

  it("has a plain message without issues", () => {
    expect(new FlagConfigError([]).message).toBe("invalid flag file");
  });

  it("never echoes more than 200 characters of input", () => {
    const long = "x".repeat(500);
    const error = configError(() => parseFlags({ version: 1, flags: { [long]: { enabled: 1 } } }));
    expect(error.message.length).toBeLessThanOrEqual(200);
    for (const issue of error.issues) {
      expect(issue.path.length).toBeLessThan(200);
      expect(issue.message.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("parseFlags", () => {
  it("reports every issue of the reference invalid file", () => {
    const error = configError(() =>
      parseFlags({
        version: 1,
        segments: {
          a: { segment: "b" },
          b: { segment: "a" },
        },
        flags: {
          beta: {
            enabled: true,
            variants: { on: true, off: false },
            rules: [
              {
                when: { attr: "country", op: "like", value: "US" },
                serve: { variant: "on" },
              },
              { segment: "ghost", serve: { variant: "on" } },
              {
                serve: {
                  rollout: [
                    { variant: "on", weight: 60 },
                    { variant: "off", weight: 30 },
                  ],
                },
              },
            ],
          },
        },
      }),
    );
    expect(error.code).toBe("invalid_config");
    const paths = error.issues.map((issue) => issue.path);
    expect(paths).toHaveLength(5);
    expect(paths).toContain("$.flags.beta.rules[0].when.op");
    expect(paths).toContain("$.flags.beta.default");
    expect(paths).toContain("$.flags.beta.rules[1].segment");
    expect(paths).toContain("$.flags.beta.rules[2].serve.rollout");
    expect(paths).toContain("$.segments.a");
    const rollout = error.issues.find((i) => i.path.endsWith("rollout"));
    expect(rollout?.message).toContain("sum to 100");
    const cycle = error.issues.find((i) => i.path === "$.segments.a");
    expect(cycle?.message).toContain("a -> b -> a");
  });

  it("reports a three-segment cycle once", () => {
    const paths = pathsOf({
      version: 1,
      segments: {
        a: { segment: "b" },
        b: { segment: "c" },
        c: { segment: "a" },
      },
      flags: {},
    });
    expect(paths).toEqual(["$.segments.a"]);
  });

  const invalidCases: Array<[string, unknown, string]> = [
    ["null input", null, "$"],
    ["array input", [], "$"],
    ["bad version", { version: 2, flags: {} }, "$.version"],
    ["missing flags", { version: 1 }, "$.flags"],
    ["flags array", { version: 1, flags: [] }, "$.flags"],
    ["segments array", { version: 1, segments: [], flags: {} }, "$.segments"],
    ["flag not object", { version: 1, flags: { f: 1 } }, "$.flags.f"],
    ["enabled string", withFlag({ enabled: "yes" }), "$.flags.f.enabled"],
    ["variants missing", withFlag({ variants: undefined }), "$.flags.f.variants"],
    ["variants empty", withFlag({ variants: {} }), "$.flags.f.variants"],
    ["variant null", withFlag({ variants: { on: null } }), "$.flags.f.variants.on"],
    ["variant array", withFlag({ variants: { off: [] } }), "$.flags.f.variants.off"],
    ["variant NaN", withFlag({ variants: { off: Number.NaN } }), "$.flags.f.variants.off"],
    ["variant function", withFlag({ variants: { off: () => 1 } }), "$.flags.f.variants.off"],
    [
      "variant infinite",
      withFlag({ variants: { off: { a: Number.POSITIVE_INFINITY } } }),
      "$.flags.f.variants.off",
    ],
    ["variant too deep", withFlag({ variants: { off: deepObject(40) } }), "$.flags.f.variants.off"],
    ["default missing", withFlag({ default: undefined }), "$.flags.f.default"],
    ["default unknown", withFlag({ default: "zzz" }), "$.flags.f.default"],
    ["off unknown", withFlag({ off: "zzz" }), "$.flags.f.off"],
    ["off number", withFlag({ off: 3 }), "$.flags.f.off"],
    ["rules object", withFlag({ rules: {} }), "$.flags.f.rules"],
    ["rule number", withRule(5), "$.flags.f.rules[0]"],
    ["serve missing", withRule({}), "$.flags.f.rules[0].serve"],
    ["serve both", withServe({ variant: "on", rollout: [] }), "$.flags.f.rules[0].serve"],
    ["serve unknown variant", withServe({ variant: "zzz" }), "$.flags.f.rules[0].serve.variant"],
    ["serve variant number", withServe({ variant: 5 }), "$.flags.f.rules[0].serve.variant"],
    ["rollout empty", withServe({ rollout: [] }), "$.flags.f.rules[0].serve.rollout"],
    ["rollout entry number", withServe({ rollout: [5] }), "$.flags.f.rules[0].serve.rollout[0]"],
    [
      "rollout unknown variant",
      withServe({ rollout: [{ variant: "zzz", weight: 100 }] }),
      "$.flags.f.rules[0].serve.rollout[0].variant",
    ],
    [
      "weight fraction",
      withServe({ rollout: [{ variant: "on", weight: 50.5 }] }),
      "$.flags.f.rules[0].serve.rollout[0].weight",
    ],
    [
      "weight above 100",
      withServe({ rollout: [{ variant: "on", weight: 101 }] }),
      "$.flags.f.rules[0].serve.rollout[0].weight",
    ],
    [
      "weight negative",
      withServe({ rollout: [{ variant: "on", weight: -1 }] }),
      "$.flags.f.rules[0].serve.rollout[0].weight",
    ],
    [
      "weight string",
      withServe({ rollout: [{ variant: "on", weight: "100" }] }),
      "$.flags.f.rules[0].serve.rollout[0].weight",
    ],
    [
      "bucketBy empty",
      withServe({ rollout: [{ variant: "on", weight: 100 }], bucketBy: "" }),
      "$.flags.f.rules[0].serve.bucketBy",
    ],
    [
      "salt number",
      withServe({ rollout: [{ variant: "on", weight: 100 }], salt: 5 }),
      "$.flags.f.rules[0].serve.salt",
    ],
    ["when number", withRule({ when: 5, serve: { variant: "on" } }), "$.flags.f.rules[0].when"],
    [
      "two condition kinds",
      withWhen({ all: [{ segment: "x" }], any: [{ segment: "x" }] }),
      "$.flags.f.rules[0].when",
    ],
    ["all empty", withWhen({ all: [] }), "$.flags.f.rules[0].when.all"],
    ["any number", withWhen({ any: 5 }), "$.flags.f.rules[0].when.any"],
    ["all child number", withWhen({ all: [5] }), "$.flags.f.rules[0].when.all[0]"],
    ["attr empty", withWhen({ attr: "", op: "eq", value: 1 }), "$.flags.f.rules[0].when.attr"],
    ["op missing", withWhen({ attr: "a", value: 1 }), "$.flags.f.rules[0].when.op"],
    ["value missing", withWhen({ attr: "a", op: "eq" }), "$.flags.f.rules[0].when.value"],
    ["eq object", withWhen({ attr: "a", op: "eq", value: {} }), "$.flags.f.rules[0].when.value"],
    ["in string", withWhen({ attr: "a", op: "in", value: "x" }), "$.flags.f.rules[0].when.value"],
    [
      "notIn nested",
      withWhen({ attr: "a", op: "notIn", value: [[1]] }),
      "$.flags.f.rules[0].when.value",
    ],
    [
      "in too long",
      withWhen({
        attr: "a",
        op: "in",
        value: Array.from({ length: 1001 }, (_, i) => i),
      }),
      "$.flags.f.rules[0].when.value",
    ],
    ["gt text", withWhen({ attr: "a", op: "gt", value: "abc" }), "$.flags.f.rules[0].when.value"],
    ["lt boolean", withWhen({ attr: "a", op: "lt", value: true }), "$.flags.f.rules[0].when.value"],
    [
      "contains number",
      withWhen({ attr: "a", op: "contains", value: 5 }),
      "$.flags.f.rules[0].when.value",
    ],
    [
      "startsWith null",
      withWhen({ attr: "a", op: "startsWith", value: null }),
      "$.flags.f.rules[0].when.value",
    ],
    [
      "semver short",
      withWhen({ attr: "a", op: "semverGte", value: "1.2" }),
      "$.flags.f.rules[0].when.value",
    ],
    ["segment number", withWhen({ segment: 5 }), "$.flags.f.rules[0].when.segment"],
    ["segment unknown", withWhen({ segment: "ghost" }), "$.flags.f.rules[0].when.segment"],
    [
      "rule segment number",
      withRule({ segment: 5, serve: { variant: "on" } }),
      "$.flags.f.rules[0].segment",
    ],
    ["self cycle", { version: 1, segments: { a: { segment: "a" } }, flags: {} }, "$.segments.a"],
    ["segment body number", { version: 1, segments: { a: 5 }, flags: {} }, "$.segments.a"],
    ["too many segments", { version: 1, segments: manySegments(101), flags: {} }, "$.segments"],
  ];

  it.each(invalidCases)("rejects %s", (_name, input, path) => {
    expect(pathsOf(input)).toContain(path);
  });

  it("accepts 100 segments", () => {
    const file = parseFlags({
      version: 1,
      segments: manySegments(100),
      flags: {},
    });
    expect(Object.keys(file.segments ?? {})).toHaveLength(100);
  });

  it("returns a normalized copy and never mutates the input", () => {
    const input = {
      version: 1,
      segments: { pro: { attr: "plan", op: "eq", value: "pro" } },
      flags: {
        cfg: {
          enabled: true,
          variants: { small: { limit: 5, tags: ["a"] }, big: { limit: 50 } },
          default: "small",
          off: "big",
          extra: "ignored",
          rules: [
            {
              segment: "pro",
              serve: {
                rollout: [{ variant: "big", weight: 100 }],
                bucketBy: "org",
                salt: "s",
              },
            },
          ],
        },
      },
    };
    const before = JSON.stringify(input);
    const file = parseFlags(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.getPrototypeOf(file.flags)).toBeNull();
    expect(Object.getPrototypeOf(file.segments)).toBeNull();
    const cfg = file.flags.cfg;
    expect(cfg?.off).toBe("big");
    expect(cfg).not.toHaveProperty("extra");
    expect(Object.isFrozen(cfg?.variants.small)).toBe(true);
    (input.flags.cfg.variants.small as { limit: number }).limit = 99;
    const result = evaluate(
      file,
      "cfg",
      ctxOf("k", { plan: "free" }),
      {} as Record<string, unknown>,
    );
    expect(result.value.limit).toBe(5);
  });

  it("accepts prototype-looking keys without polluting anything", () => {
    const text =
      '{"version":1,"flags":{"__proto__":{"enabled":true,' +
      '"variants":{"__proto__":true},"default":"__proto__"}}}';
    const file = parseFlagsJson(text);
    expect(Object.keys(file.flags)).toEqual(["__proto__"]);
    const result = evaluate<boolean>(file, "__proto__", ctxOf("k"), false);
    expect(result.value).toBe(true);
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });
});

describe("parseFlagsJson limits", () => {
  const base = JSON.stringify({ version: 1, flags: {} });
  const padded = (length: number): string => base + " ".repeat(length - base.length);

  it("enforces the text length limit", () => {
    expect(parseFlagsJson(padded(1_000_000)).flags).toBeDefined();
    const error = configError(() => parseFlagsJson(padded(1_000_001)));
    expect(error.issues[0]?.path).toBe("$");
    expect(error.issues[0]?.message).toContain("1000000");
    expect(LIMITS.maxTextLength).toBe(1_000_000);
  });

  it("rejects invalid JSON and non-string input", () => {
    expect(configError(() => parseFlagsJson("{")).issues[0]?.message).toContain("not valid JSON");
    const bad = 5 as unknown as string;
    expect(configError(() => parseFlagsJson(bad)).code).toBe("invalid_config");
  });

  it("enforces the flag count limit", () => {
    const ok = JSON.stringify({ version: 1, flags: manyFlags(1000, okFlag) });
    expect(Object.keys(parseFlagsJson(ok).flags)).toHaveLength(1000);
    const tooMany = JSON.stringify({
      version: 1,
      flags: manyFlags(1001, okFlag),
    });
    const error = configError(() => parseFlagsJson(tooMany));
    expect(error.issues.map((i) => i.path)).toContain("$.flags");
  });

  it("enforces the rule count limit", () => {
    const rule = { serve: { variant: "on" } };
    const build = (count: number): string =>
      JSON.stringify({
        version: 1,
        flags: { f: { ...okFlag, rules: Array(count).fill(rule) } },
      });
    expect(parseFlagsJson(build(100)).flags.f?.rules).toHaveLength(100);
    const error = configError(() => parseFlagsJson(build(101)));
    expect(error.issues.map((i) => i.path)).toContain("$.flags.f.rules");
  });

  it("enforces the condition depth limit", () => {
    const build = (depth: number): string => JSON.stringify(withWhen(nest(depth)));
    expect(parseFlagsJson(build(16)).flags.f?.rules).toHaveLength(1);
    const error = configError(() => parseFlagsJson(build(17)));
    expect(error.issues[0]?.message).toContain("nested deeper than 16");
  });

  it("enforces the condition node limit on shared structures", () => {
    const leaf = { attr: "a", op: "eq", value: 1 };
    const level2 = { all: Array(100).fill(leaf) };
    const level3 = { all: Array(100).fill(level2) };
    const level4 = { all: Array(100).fill(level3) };
    const error = configError(() => parseFlags(withWhen(level4)));
    expect(error.issues.some((i) => i.message.includes("more than"))).toBe(true);
  });

  it("lists at most 100 issues", () => {
    const input = { version: 1, flags: manyFlags(150, {}) };
    expect(configError(() => parseFlags(input)).issues).toHaveLength(100);
  });
});

describe("evaluate ordering and reasons", () => {
  const file = load(
    {
      f: {
        ...okFlag,
        rules: [
          {
            when: { attr: "plan", op: "eq", value: "pro" },
            serve: { variant: "on" },
          },
          {
            when: { attr: "country", op: "in", value: ["US", "CA"] },
            serve: { rollout: [{ variant: "on", weight: 100 }] },
          },
        ],
      },
    },
    undefined,
  );

  it("returns the first matching rule", () => {
    const both = evaluate<boolean>(file, "f", ctxOf("u", { plan: "pro", country: "US" }), false);
    expect(both).toEqual({
      value: true,
      variant: "on",
      reason: "TARGETING_MATCH",
      ruleIndex: 0,
    });
  });

  it("reports SPLIT with the rule index", () => {
    const result = evaluate<boolean>(file, "f", ctxOf("u", { plan: "free", country: "US" }), false);
    expect(result).toEqual({
      value: true,
      variant: "on",
      reason: "SPLIT",
      ruleIndex: 1,
    });
  });

  it("falls back to the default variant without a ruleIndex", () => {
    const result = evaluate<boolean>(file, "f", ctxOf("u"), true);
    expect(result.reason).toBe("DEFAULT");
    expect(result.variant).toBe("off");
    expect(result.value).toBe(false);
    expect(result).not.toHaveProperty("ruleIndex");
    expect(result).not.toHaveProperty("errorCode");
  });

  it("returns the default variant for a flag without rules", () => {
    const plain = load({ f: okFlag });
    expect(evaluate<boolean>(plain, "f", ctxOf("u"), true).reason).toBe("DEFAULT");
  });

  it("treats a rule without segment and when as a catch-all", () => {
    const all = load({
      f: { ...okFlag, rules: [{ serve: { variant: "on" } }] },
    });
    const result = evaluate<boolean>(all, "f", ctxOf("u"), false);
    expect(result.reason).toBe("TARGETING_MATCH");
  });
});

describe("operators", () => {
  const cases: Array<[string, unknown, Record<string, unknown>, boolean]> = [
    ["eq hit", { attr: "p", op: "eq", value: "a" }, { p: "a" }, true],
    ["eq miss", { attr: "p", op: "eq", value: "a" }, { p: "b" }, false],
    ["eq no coercion", { attr: "p", op: "eq", value: 5 }, { p: "5" }, false],
    ["eq null", { attr: "p", op: "eq", value: null }, { p: null }, true],
    ["neq hit", { attr: "p", op: "neq", value: "a" }, { p: "b" }, true],
    ["neq miss", { attr: "p", op: "neq", value: "a" }, { p: "a" }, false],
    ["neq missing attr", { attr: "p", op: "neq", value: "a" }, {}, false],
    ["in hit", { attr: "p", op: "in", value: ["a", "b"] }, { p: "b" }, true],
    ["in miss", { attr: "p", op: "in", value: ["a", "b"] }, { p: "c" }, false],
    ["in missing", { attr: "p", op: "in", value: ["a"] }, {}, false],
    ["notIn hit", { attr: "p", op: "notIn", value: ["a"] }, { p: "c" }, true],
    ["notIn miss", { attr: "p", op: "notIn", value: ["a"] }, { p: "a" }, false],
    ["notIn missing", { attr: "p", op: "notIn", value: ["a"] }, {}, false],
    ["gt string numbers", { attr: "n", op: "gt", value: "9" }, { n: "10" }, true],
    ["gt empty string", { attr: "n", op: "gt", value: "9" }, { n: "" }, false],
    ["gt hex string", { attr: "n", op: "gt", value: "9" }, { n: "0x10" }, false],
    ["gt blank", { attr: "n", op: "gt", value: "9" }, { n: " " }, false],
    ["gt number", { attr: "n", op: "gt", value: "9" }, { n: 10 }, true],
    ["gt equal", { attr: "n", op: "gt", value: "9" }, { n: "9" }, false],
    ["gt exponent", { attr: "n", op: "gt", value: "9" }, { n: "1e3" }, false],
    ["gt trailing dot", { attr: "n", op: "gt", value: "9" }, { n: "10." }, false],
    ["gt text", { attr: "n", op: "gt", value: "9" }, { n: "abc" }, false],
    ["gt boolean", { attr: "n", op: "gt", value: 0 }, { n: true }, false],
    ["gt infinity", { attr: "n", op: "gt", value: 0 }, { n: Infinity }, false],
    ["gt object", { attr: "n", op: "gt", value: 0 }, { n: {} }, false],
    ["lt numeric not lexical", { attr: "n", op: "lt", value: "10" }, { n: "5" }, true],
    ["lt miss", { attr: "n", op: "lt", value: "5" }, { n: "10" }, false],
    ["lt negative", { attr: "n", op: "lt", value: 0 }, { n: "-1.5" }, true],
    ["lt text", { attr: "n", op: "lt", value: 10 }, { n: "x" }, false],
    ["contains hit", { attr: "p", op: "contains", value: "ell" }, { p: "hello" }, true],
    ["contains miss", { attr: "p", op: "contains", value: "xyz" }, { p: "hello" }, false],
    ["contains number", { attr: "p", op: "contains", value: "5" }, { p: 5 }, false],
    ["startsWith hit", { attr: "p", op: "startsWith", value: "he" }, { p: "hello" }, true],
    ["startsWith miss", { attr: "p", op: "startsWith", value: "lo" }, { p: "hello" }, false],
    ["startsWith number", { attr: "p", op: "startsWith", value: "1" }, { p: 1 }, false],
    [
      "semver newer minor",
      { attr: "app", op: "semverGte", value: "1.9.0" },
      { app: "1.10.0" },
      true,
    ],
    ["semver equal", { attr: "app", op: "semverGte", value: "1.9.0" }, { app: "1.9.0" }, true],
    ["semver major", { attr: "app", op: "semverGte", value: "1.9.0" }, { app: "2.0.0" }, true],
    ["semver older", { attr: "app", op: "semverGte", value: "1.9.0" }, { app: "1.8.99" }, false],
    ["semver two parts", { attr: "app", op: "semverGte", value: "1.9.0" }, { app: "1.2" }, false],
    [
      "semver prerelease",
      { attr: "app", op: "semverGte", value: "1.9.0" },
      { app: "1.2.3-beta" },
      false,
    ],
    [
      "semver leading zero",
      { attr: "app", op: "semverGte", value: "1.9.0" },
      { app: "01.2.3" },
      false,
    ],
    [
      "semver v prefix",
      { attr: "app", op: "semverGte", value: "1.9.0" },
      { app: "v1.10.0" },
      false,
    ],
    ["semver padded", { attr: "app", op: "semverGte", value: "1.9.0" }, { app: " 1.10.0" }, false],
    ["semver number", { attr: "app", op: "semverGte", value: "1.9.0" }, { app: 2 }, false],
  ];

  it.each(cases)("%s", (_name, cond, attrs, expected) => {
    expect(matches(cond, attrs)).toBe(expected);
  });

  it("combines conditions with all and any", () => {
    const pro = { attr: "plan", op: "eq", value: "pro" };
    const us = { attr: "country", op: "eq", value: "US" };
    const both = { all: [pro, us] };
    const either = { any: [pro, us] };
    expect(matches(both, { plan: "pro", country: "US" })).toBe(true);
    expect(matches(both, { plan: "pro", country: "DE" })).toBe(false);
    expect(matches(either, { plan: "free", country: "US" })).toBe(true);
    expect(matches(either, { plan: "free", country: "DE" })).toBe(false);
    expect(matches({ all: [either, { any: [pro] }] }, { plan: "pro" })).toBe(true);
  });
});

describe("segments", () => {
  const segments = {
    pro: { attr: "plan", op: "eq", value: "pro" },
    us: { attr: "country", op: "eq", value: "US" },
    proUs: { all: [{ segment: "pro" }, { segment: "us" }] },
    either: { any: [{ segment: "pro" }, { segment: "pro" }] },
  };
  const file = load(
    {
      f: {
        ...okFlag,
        rules: [
          { segment: "proUs", serve: { variant: "on" } },
          {
            segment: "either",
            when: { attr: "country", op: "eq", value: "DE" },
            serve: { variant: "on" },
          },
          { when: { segment: "us" }, serve: { variant: "on" } },
        ],
      },
    },
    segments,
  );

  it("resolves nested segment references", () => {
    const hit = evaluate<boolean>(file, "f", ctxOf("k", { plan: "pro", country: "US" }), false);
    expect(hit.ruleIndex).toBe(0);
  });

  it("requires both segment and when on one rule", () => {
    const hit = evaluate<boolean>(file, "f", ctxOf("k", { plan: "pro", country: "DE" }), false);
    expect(hit.ruleIndex).toBe(1);
    const miss = evaluate<boolean>(file, "f", ctxOf("k", { plan: "free", country: "DE" }), false);
    expect(miss.reason).toBe("DEFAULT");
  });

  it("supports a segment reference inside when", () => {
    const hit = evaluate<boolean>(file, "f", ctxOf("k", { plan: "free", country: "US" }), false);
    expect(hit.ruleIndex).toBe(2);
  });
});

describe("rollouts", () => {
  const split = (rollout: unknown, extra: Record<string, unknown> = {}) =>
    load({
      beta: {
        ...okFlag,
        rules: [{ serve: { rollout, ...extra } }],
      },
    });
  const fiftyFifty = [
    { variant: "on", weight: 50 },
    { variant: "off", weight: 50 },
  ];

  it("splits 10000 keys exactly and sticks per key", () => {
    const file = split(fiftyFifty);
    let on = 0;
    let off = 0;
    for (let i = 0; i < 10000; i += 1) {
      const result = evaluate<boolean>(file, "beta", ctxOf(`user-${i}`), false);
      if (result.variant === "on") {
        on += 1;
      } else {
        off += 1;
      }
    }
    expect(on).toBe(5010);
    expect(off).toBe(4990);
    const first = evaluate<boolean>(file, "beta", ctxOf("user-7"), false);
    for (let i = 0; i < 20; i += 1) {
      expect(evaluate<boolean>(file, "beta", ctxOf("user-7"), false)).toEqual(first);
    }
  });

  it("uses the salt as the seed and bucketBy as the attribute", () => {
    const file = split(fiftyFifty, { salt: "s2", bucketBy: "org" });
    for (let i = 0; i < 50; i += 1) {
      const result = evaluate<boolean>(file, "beta", ctxOf("ignored", { org: `org-${i}` }), false);
      expect(result.variant).toBe(bucket("s2", `org-${i}`) < 5000 ? "on" : "off");
    }
  });

  it("buckets finite numbers by their string form", () => {
    const file = split(fiftyFifty, { bucketBy: "n" });
    const result = evaluate<boolean>(file, "beta", ctxOf("k", { n: 42 }), false);
    expect(result.variant).toBe(bucket("beta", "42") < 5000 ? "on" : "off");
    expect(result.reason).toBe("SPLIT");
  });

  it("skips the rule when the bucketBy attribute is unusable", () => {
    const file = split([{ variant: "on", weight: 100 }], { bucketBy: "tier" });
    const unusable: unknown[] = [undefined, {}, [], true, null, Number.NaN, Infinity];
    for (const tier of unusable) {
      const attrs = tier === undefined ? {} : { tier };
      const result = evaluate<boolean>(file, "beta", ctxOf("k", attrs), true);
      expect(result.reason).toBe("DEFAULT");
    }
    const ok = evaluate<boolean>(file, "beta", ctxOf("k", { tier: "x" }), true);
    expect(ok.reason).toBe("SPLIT");
  });

  it("never buckets by a prototype attribute", () => {
    const file = split([{ variant: "on", weight: 100 }], {
      bucketBy: "__proto__",
    });
    const ctx = JSON.parse('{"key":"k","__proto__":"x"}') as EvaluationContext;
    expect(evaluate<boolean>(file, "beta", ctx, true).reason).toBe("DEFAULT");
  });

  it("handles weight 0 and a single 100 percent bucket", () => {
    const zero = split([
      { variant: "on", weight: 0 },
      { variant: "off", weight: 100 },
    ]);
    const single = split([{ variant: "on", weight: 100 }]);
    for (let i = 0; i < 200; i += 1) {
      const key = ctxOf(`user-${i}`);
      expect(evaluate<boolean>(zero, "beta", key, true).variant).toBe("off");
      expect(evaluate<boolean>(single, "beta", key, false).variant).toBe("on");
    }
  });

  it("skips a hand-built rollout that does not cover the bucket", () => {
    const file: FlagFile = {
      version: 1,
      flags: {
        beta: {
          enabled: true,
          variants: { on: true, off: false },
          default: "off",
          rules: [{ serve: { rollout: [{ variant: "on", weight: 25 }] } }],
        },
      },
    };
    const reasons = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const key = `user-${i}`;
      const result = evaluate<boolean>(file, "beta", ctxOf(key), false);
      expect(result.reason).toBe(bucket("beta", key) < 2500 ? "SPLIT" : "DEFAULT");
      reasons.add(result.reason);
    }
    expect(reasons.size).toBe(2);
  });
});

describe("evaluate never throws", () => {
  it("treats missing and prototype attributes as non-matching", () => {
    expect(matches({ attr: "nope", op: "eq", value: 1 }, {})).toBe(false);
    expect(matches({ attr: "__proto__", op: "eq", value: "x" }, {})).toBe(false);
    expect(matches({ attr: "constructor", op: "neq", value: "x" }, {})).toBe(false);
    expect(matches({ attr: "toString", op: "neq", value: "x" }, {})).toBe(false);
    const own = JSON.parse('{"key":"k","__proto__":"x"}') as EvaluationContext;
    const file = load({
      f: {
        ...okFlag,
        rules: [
          {
            when: { attr: "__proto__", op: "eq", value: "x" },
            serve: { variant: "on" },
          },
        ],
      },
    });
    expect(evaluate<boolean>(file, "f", own, true).reason).toBe("DEFAULT");
    expect(matches({ attr: "constructor", op: "eq", value: "x" }, { constructor: "x" })).toBe(
      false,
    );
  });

  it("ignores attribute strings above the size limit", () => {
    const cond = { attr: "big", op: "neq", value: "x" };
    const atLimit = "y".repeat(LIMITS.maxAttributeLength);
    expect(matches(cond, { big: atLimit })).toBe(true);
    expect(matches(cond, { big: `${atLimit}y` })).toBe(false);
  });

  it("returns false for operands that are invalid at runtime", () => {
    const hand = (when: unknown): FlagFile => ({
      version: 1,
      flags: {
        f: {
          enabled: true,
          variants: { on: true, off: false },
          default: "off",
          rules: [{ when: when as ff.Condition, serve: { variant: "on" } }],
        },
      },
    });
    const run = (when: unknown, attrs: Record<string, unknown>): boolean =>
      evaluate<boolean>(hand(when), "f", ctxOf("k", attrs), false).value;
    expect(run({ attr: "a", op: "in", value: "x" }, { a: "x" })).toBe(false);
    expect(run({ attr: "a", op: "notIn", value: 1 }, { a: "x" })).toBe(false);
    expect(run({ attr: "a", op: "contains", value: 5 }, { a: "5" })).toBe(false);
    expect(run({ attr: "a", op: "startsWith", value: 5 }, { a: "5" })).toBe(false);
    expect(run({ attr: "a", op: "gt", value: "abc" }, { a: 5 })).toBe(false);
    expect(run({ attr: "a", op: "semverGte", value: 1 }, { a: "1.0.0" })).toBe(false);
    expect(run({ attr: "a", op: "like", value: 1 }, { a: 1 })).toBe(false);
  });

  it("survives hand-built malformed files", () => {
    const broken = { version: 1, flags: null } as unknown as FlagFile;
    expect(evaluate(broken, "f", ctxOf("k"), false)).toEqual({
      value: false,
      variant: null,
      reason: "ERROR",
    });
    const nullCtx = null as unknown as EvaluationContext;
    const file = load({
      f: { ...okFlag, rules: [{ serve: { rollout: [{ variant: "on", weight: 100 }] } }] },
    });
    expect(evaluate<boolean>(file, "f", nullCtx, false).reason).toBe("ERROR");
  });

  it("reports an ERROR for a hand-built unknown variant", () => {
    const file: FlagFile = {
      version: 1,
      flags: {
        f: { enabled: true, variants: {}, default: "zzz" },
      },
    };
    expect(evaluate<boolean>(file, "f", ctxOf("k"), true)).toEqual({
      value: true,
      variant: null,
      reason: "ERROR",
    });
  });

  it("does not loop on hand-built segment cycles or unknown segments", () => {
    const def = {
      enabled: true,
      variants: { on: true, off: false },
      default: "off",
    };
    const cyclic: FlagFile = {
      version: 1,
      segments: { a: { segment: "b" }, b: { segment: "a" } },
      flags: {
        f: { ...def, rules: [{ segment: "a", serve: { variant: "on" } }] },
      },
    };
    expect(evaluate<boolean>(cyclic, "f", ctxOf("k"), true).reason).toBe("DEFAULT");
    const noSegments: FlagFile = {
      version: 1,
      flags: {
        f: { ...def, rules: [{ segment: "ghost", serve: { variant: "on" } }] },
      },
    };
    expect(evaluate<boolean>(noSegments, "f", ctxOf("k"), true).reason).toBe("DEFAULT");
  });
});

describe("disabled flags and errors", () => {
  const file = load({
    disabledOff: { ...okFlag, enabled: false, off: "off", default: "on" },
    disabledDefault: { ...okFlag, enabled: false, default: "on" },
    text: { enabled: true, variants: { hi: "hello" }, default: "hi" },
    num: { enabled: true, variants: { n: 3 }, default: "n" },
    obj: { enabled: true, variants: { o: { a: 1 } }, default: "o" },
  });

  it("returns the off variant with reason DISABLED", () => {
    expect(evaluate<boolean>(file, "disabledOff", ctxOf("k"), true)).toEqual({
      value: false,
      variant: "off",
      reason: "DISABLED",
    });
  });

  it("falls back to the default variant when no off variant is set", () => {
    const result = evaluate<boolean>(file, "disabledDefault", ctxOf("k"), false);
    expect(result.value).toBe(true);
    expect(result.reason).toBe("DISABLED");
  });

  it("returns the fallback for unknown keys", () => {
    const expected = {
      value: "x",
      variant: null,
      reason: "ERROR",
      errorCode: "FLAG_NOT_FOUND",
    };
    expect(evaluate<string>(file, "nope", ctxOf("k"), "x")).toEqual(expected);
    expect(evaluate<string>(file, "__proto__", ctxOf("k"), "x")).toEqual(expected);
    expect(evaluate<string>(file, "constructor", ctxOf("k"), "x")).toEqual(expected);
  });

  it("reports TYPE_MISMATCH when the variant type differs from the fallback", () => {
    const result = evaluate<boolean>(file, "text", ctxOf("k"), false);
    expect(result).toEqual({
      value: false,
      variant: null,
      reason: "ERROR",
      errorCode: "TYPE_MISMATCH",
    });
    expect(evaluate<string>(file, "num", ctxOf("k"), "x").errorCode).toBe("TYPE_MISMATCH");
    const arrayFallback = [] as unknown as Record<string, unknown>;
    expect(evaluate(file, "obj", ctxOf("k"), arrayFallback).errorCode).toBe("TYPE_MISMATCH");
    const disabled = evaluate<string>(file, "disabledOff", ctxOf("k"), "x");
    expect(disabled.errorCode).toBe("TYPE_MISMATCH");
  });

  it("matches types for strings, numbers and objects", () => {
    expect(evaluate<string>(file, "text", ctxOf("k"), "d").value).toBe("hello");
    expect(evaluate<number>(file, "num", ctxOf("k"), 0).value).toBe(3);
    const fallback: Record<string, unknown> = {};
    expect(evaluate(file, "obj", ctxOf("k"), fallback).value.a).toBe(1);
  });
});
