import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Immutable source of the published levels/v0.1.0 release. Fetch history when
// running this fixture in a shallow registry checkout.
const release = "5287d31b787c56f4aff6d7c6dd1e782935c29c1a";
const root = await realpath(fileURLToPath(new URL("../..", import.meta.url)));
const core = process.env.CICORD_SOURCE && (await realpath(process.env.CICORD_SOURCE));
if (!core) throw Error("Set CICORD_SOURCE to the companion 0.2 engine checkout");
const tmp = await mkdtemp(join(tmpdir(), "cicord-mixed-levels-"));
try {
  const legacy = join(tmp, "release");
  await mkdir(legacy);
  const archive = execFileSync("git", ["archive", "--format=tar", release, "plugins/levels"], {
    cwd: root,
  });
  execFileSync("tar", ["-xf", "-", "-C", legacy], { input: archive });
  const overlay = join(tmp, "overlay.json");
  await writeFile(
    overlay,
    JSON.stringify({
      Replace: {
        [join(core, "internal/runtime/registry_mixed_levels_test.go")]: join(
          root,
          "scripts/interop/mixed_levels_test.go",
        ),
      },
    }),
  );
  const result = execFileSync(
    "go",
    [
      "test",
      "-p=1",
      "-parallel=1",
      "-overlay",
      overlay,
      "-ldflags",
      "-X github.com/cicord/cicord/internal/version.Version=0.2.0",
      "./internal/runtime",
      "-run",
      "^TestRegistryMixedLevels$",
      "-timeout=5m",
      "-count=1",
      "-v",
    ],
    {
      cwd: core,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        GOMAXPROCS: process.env.GOMAXPROCS ?? "2",
        CICORD_MIXED_PLUGINS: join(root, "plugins"),
        CICORD_MIXED_LEGACY: join(legacy, "plugins", "levels"),
      },
    },
  );
  process.stdout.write(result);
  if (!result.includes("--- PASS: TestRegistryMixedLevels ("))
    throw Error("mixed installed-plugin fixture did not execute");
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  throw error;
} finally {
  await rm(tmp, { recursive: true, force: true });
}
