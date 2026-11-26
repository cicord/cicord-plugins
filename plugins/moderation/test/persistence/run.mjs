import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const core = process.env.CICORD_SOURCE;
if (!core) throw new Error("Set CICORD_SOURCE to the Cicord engine checkout.");
const dir = await mkdtemp(join(tmpdir(), "moderation-restore-"));
try {
  const overlay = join(dir, "overlay.json");
  const fixture = fileURLToPath(new URL("ban_restore_test.go", import.meta.url));
  await writeFile(overlay, JSON.stringify({
    Replace: { [resolve(core, "internal/runtime/registry_ban_restore_test.go")]: fixture },
  }));
  execFileSync("go", ["test", "-overlay", overlay, "./internal/runtime", "-run", "^TestRegistryBanEraseAndRestore$", "-count=1"], {
    cwd: core, stdio: "inherit",
    env: {...process.env, CICORD_MODERATION_SRC: fileURLToPath(new URL("../../src", import.meta.url))},
  });
} finally {
  await rm(dir, {recursive:true,force:true});
}
