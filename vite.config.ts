import { defineConfig } from "vite-plus";

// Unit tests of the plugins (plugins/<name>/test/*.test.ts, with @cicord/sdk/testing).
export default defineConfig({
  test: {
    include: ["plugins/*/test/**/*.test.ts"],
  },
});
