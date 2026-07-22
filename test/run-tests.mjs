import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const outDir = ".test-dist";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

rmSync(outDir, { recursive: true, force: true });
try {
  const compiled = run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--noEmit", "false",
    "--outDir", outDir,
    "--rootDir", "extensions",
  ]);
  if (compiled) {
    run(process.execPath, [
      "--test",
      "test/editor-state.test.mjs",
      "test/tool-boundary.test.mjs",
    ]);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
