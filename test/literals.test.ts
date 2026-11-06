import { describe, expect, it } from "vitest";
import { bucket, evaluate, fnv1a32, parseFlags } from "../src/index.js";

const enc = new TextEncoder();

describe("acceptance literals", () => {
  it("{ attr: 'n', op: 'gt', value: '9' } matches n '10' but not n '' or '0x10'", () => {
    const file = parseFlags({
      version: 1,
      flags: {
        f: {
          enabled: true,
          variants: { on: true, off: false },
          default: "off",
          rules: [{ when: { attr: "n", op: "gt", value: "9" }, serve: { variant: "on" } }],
        },
      },
    });
    expect(evaluate(file, "f", { key: "k", n: "10" }, false).value).toBe(true);
    expect(evaluate(file, "f", { key: "k", n: "" }, false).value).toBe(false);
    expect(evaluate(file, "f", { key: "k", n: "0x10" }, false).value).toBe(false);
  });

  it("fnv1a32 of '', 'a' and 'foobar' returns 0x811c9dc5, 0xe40c292c and 0xbf9cf968; bucket('beta', 'user-1') === 4142", () => {
    expect(fnv1a32(enc.encode(""))).toBe(0x811c9dc5);
    expect(fnv1a32(enc.encode("a"))).toBe(0xe40c292c);
    expect(fnv1a32(enc.encode("foobar"))).toBe(0xbf9cf968);
    expect(bucket("beta", "user-1")).toBe(4142);
    expect(bucket("beta", "user-42")).toBe(2813);
  });

  it("rollout [{ variant: 'on', weight: 50 }, { variant: 'off', weight: 50 }], keys 'user-0' to 'user-9999' get 'on' exactly 5010 times and 'off' 4990 times", () => {
    const file = parseFlags({
      version: 1,
      flags: {
        beta: {
          enabled: true,
          variants: { on: true, off: false },
          default: "off",
          rules: [
            {
              serve: {
                rollout: [
                  { variant: "on", weight: 50 },
                  { variant: "off", weight: 50 },
                ],
              },
            },
          ],
        },
      },
    });
    let on = 0;
    for (let i = 0; i < 10000; i++) {
      if (evaluate(file, "beta", { key: `user-${i}` }, false).variant === "on") on++;
    }
    expect(on).toBe(5010);
    expect(10000 - on).toBe(4990);
  });
});
