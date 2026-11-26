import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const core = process.env.CICORD_SOURCE && (await realpath(process.env.CICORD_SOURCE));
if (!core) throw new Error("Set CICORD_SOURCE to the Cicord 0.2.0 engine checkout");
const fixture = fileURLToPath(new URL("levels_test.go", import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), "levels-store-test-"));
try {
  const overlay = join(tmp, "overlay.json");
  await writeFile(
    overlay,
    JSON.stringify({
      Replace: { [resolve(core, "internal/plugin/registry_levels_test.go")]: fixture },
    }),
  );
  const result = execFileSync(
    "go",
    [
      "test",
      "-overlay",
      overlay,
      "./internal/plugin",
      "-run",
      "^TestLevelsPublishedMigration$",
      "-count=1",
      "-v",
    ],
    {
      cwd: core,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        CICORD_LEVELS_PLUGIN: fileURLToPath(new URL("../..", import.meta.url)),
      },
    },
  );
  process.stdout.write(result);
  if (
    !result.includes("--- PASS: TestLevelsPublishedMigration (") ||
    (process.env.CICORD_TEST_POSTGRES_URL && result.includes("--- SKIP:"))
  )
    throw new Error("Expected migration fixture and database backends did not run");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
