import { describe, expect, it } from "vitest";
import {
  A2UI_CATALOGUE_VERSION,
  createProducerRegistry,
  producerRef,
  producerSupported,
  type SavedProducer,
} from "../src/index.ts";

const producer = (version: number, source = "export default () => null;"): SavedProducer => ({
  name: "tasks.overdueCard",
  version,
  catalogue: 1,
  description: "Overdue tasks",
  source,
});

describe("the producer registry", () => {
  it("finds the newest version, or the one asked for", () => {
    const registry = createProducerRegistry([producer(1), producer(2)]);
    expect(registry.get("tasks.overdueCard")?.version).toBe(2);
    expect(registry.get("tasks.overdueCard", 1)?.version).toBe(1);
    expect(registry.get("tasks.other")).toBeUndefined();
    expect(registry.list().map(producerRef)).toEqual(["tasks.overdueCard@2"]);
  });

  it("will not change a version's source: a stable id must always mean the same code", () => {
    const registry = createProducerRegistry([producer(1)]);
    expect(() => registry.register(producer(1))).not.toThrow();
    expect(() => registry.register(producer(1, "export default () => 1;"))).toThrow(
      "different source",
    );
  });

  it("takes plugins' producers in and out", () => {
    const registry = createProducerRegistry();
    registry.register({ ...producer(1), name: "plugin.card" });
    expect(registry.get("plugin.card")).toBeDefined();
    registry.remove("plugin.card");
    expect(registry.get("plugin.card")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("refuses a bad name", () => {
    expect(() =>
      createProducerRegistry().register({ ...producer(1), name: "no spaces allowed" }),
    ).toThrow();
  });

  it("knows when a producer targets a newer catalogue than the host renders", () => {
    expect(producerSupported({ catalogue: A2UI_CATALOGUE_VERSION })).toBe(true);
    expect(producerSupported({ catalogue: A2UI_CATALOGUE_VERSION + 1 })).toBe(false);
  });
});
