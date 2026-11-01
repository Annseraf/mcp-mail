import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The compatibility gate needs a build and a mail server; it runs via `npm run test:compat`.
    include: process.env.COMPAT_GATE ? ["test/compat/gate.test.ts"] : ["test/**/*.test.ts"],
    exclude: process.env.COMPAT_GATE ? [] : ["test/compat/gate.test.ts", "node_modules/**"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
