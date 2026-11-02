import { defineConfig } from "vitest/config";

// Integration suites need a mail server (GreenMail) and, for the gate, a build.
// They run via `npm run test:compat`; `npm test` runs the unit suites.
const integration = ["test/compat/gate.test.ts", "test/platform/**/*.int.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    include: process.env.COMPAT_GATE ? integration : ["test/**/*.test.ts"],
    exclude: process.env.COMPAT_GATE ? [] : [...integration, "node_modules/**"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
