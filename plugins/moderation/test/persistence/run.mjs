import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const core = process.env.CICORD_SOURCE && (await realpath(process.env.CICORD_SOURCE));
if (!core) throw new Error("Set CICORD_SOURCE to the Cicord engine checkout.");
const dir = await mkdtemp(join(tmpdir(), "moderation-restore-"));
try {
  const overlay = join(dir, "overlay.json");
  const fixture = fileURLToPath(new URL("ban_restore_test.go", import.meta.url));
  const migration = fileURLToPath(new URL("migration_test.go", import.meta.url));
  await writeFile(
    overlay,
    JSON.stringify({
      Replace: {
        [resolve(core, "internal/runtime/registry_ban_restore_test.go")]: fixture,
        [resolve(core, "internal/plugin/registry_moderation_migration_test.go")]: migration,
      },
    }),
  );
  const result = execFileSync(
    "go",
    [
      "test",
      "-overlay",
      overlay,
      "./internal/runtime",
      "./internal/plugin",
      "-run",
      "^TestRegistry(BanEraseAndRestore|ModerationCaseMigration)$",
      "-count=1",
      "-v",
    ],
    {
      cwd: core,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        CICORD_MODERATION_SRC: fileURLToPath(new URL("../../src", import.meta.url)),
      },
    },
  );
  process.stdout.write(result);
  if(process.env.CICORD_TEST_POSTGRES_URL && !result.includes("--- PASS: TestRegistryModerationCaseMigration/Postgres ("))throw new Error("The required PostgreSQL migration case did not run");
  for (const name of ["TestRegistryBanEraseAndRestore", "TestRegistryModerationCaseMigration"])
    if (!result.includes("--- PASS: " + name + " ("))
      throw new Error("Missing persistence case: " + name);
} finally {
  await rm(dir, { recursive: true, force: true });
}
