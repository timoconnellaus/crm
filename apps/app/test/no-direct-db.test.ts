// Acceptance criterion 1 (stage 1): the UI never touches D1 directly. Only server code in
// src/server/ may import the database package or read the DB binding; routes, components and
// client libraries go through operations (callOp).
import { describe, expect, it } from "vitest";

// Vite inlines every UI source file as text at build time, so this runs inside workerd.
const sources = import.meta.glob(["../src/**/*.{ts,tsx}", "!../src/server/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FORBIDDEN = [
  { pattern: /from\s+["']@relationship-os\/db["']/, why: "imports @relationship-os/db" },
  { pattern: /\benv\.DB\b/, why: "reads the DB binding" },
  { pattern: /\.prepare\(\s*["'`]/, why: "prepares SQL" },
];

describe("UI code", () => {
  it("is scanned", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it("never touches D1 directly", () => {
    const offenders = Object.entries(sources).flatMap(([file, text]) =>
      FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ why }) => `${file} ${why}`),
    );
    expect(offenders).toEqual([]);
  });
});
