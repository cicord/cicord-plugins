import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = process.env.CICORD_SOURCE;
if (!source) throw new Error("Set CICORD_SOURCE to the Cicord 0.2.0 engine checkout");
const core = await realpath(source);
const fixture = fileURLToPath(new URL("community_migration_test.go", import.meta.url));
const tmp = await mkdtemp(join(tmpdir(), "community-plugin-store-"));
try {
  const overlay = join(tmp, "overlay.json");
  await writeFile(
    overlay,
    JSON.stringify({
      Replace: { [resolve(core, "internal/plugin/registry_community_migration_test.go")]: fixture },
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
      "^TestCommunityPublishedMigrations$",
      "-count=1",
      "-v",
    ],
    {
      cwd: core,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        CICORD_REGISTRY_PLUGINS: fileURLToPath(new URL("../../..", import.meta.url)),
      },
    },
  );
  process.stdout.write(result);
  if (
    !result.includes("--- PASS: TestCommunityPublishedMigrations (") ||
    (process.env.CICORD_TEST_POSTGRES_URL && result.includes("--- SKIP:"))
  )
    throw Error("migration acceptance did not execute");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
