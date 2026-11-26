import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const core = process.env.CICORD_SOURCE;
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
  execFileSync(
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
      stdio: "inherit",
      env: {
        ...process.env,
        CICORD_LEVELS_PLUGIN: fileURLToPath(new URL("../..", import.meta.url)),
      },
    },
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
