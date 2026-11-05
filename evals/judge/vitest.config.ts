// Plain Node tests: the recorder, the calibration arithmetic, and every labelled set replayed
// from its committed recordings. Nothing here reaches TypeSafe (CI has no key and only replays).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
