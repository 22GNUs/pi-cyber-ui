import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../publish.sh", import.meta.url));

test("publish script keeps registry and credentials process-local", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /npm config set/);
  assert.doesNotMatch(source, /grep .*_authToken/);
  assert.match(source, /mktemp/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /--userconfig/);
  assert.match(source, /--registry/);

  const syntax = spawnSync("bash", ["-n", scriptPath]);
  assert.equal(syntax.status, 0);

  const help = spawnSync(scriptPath, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /不会修改全局 registry 或缓存 token/);
});
