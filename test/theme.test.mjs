import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const themeUrl = new URL("../themes/cyber-ui-dark.json", import.meta.url);
const paletteUrl = new URL("../extensions/pi-cyber-ui/palette.ts", import.meta.url);

test("theme variables are valid, referenced, and resolve every color token", () => {
  const theme = JSON.parse(readFileSync(themeUrl, "utf8"));
  const paletteSource = readFileSync(paletteUrl, "utf8");
  const vars = theme.vars;

  for (const [name, value] of Object.entries(vars)) {
    assert.match(value, /^#[0-9a-f]{6}$/i, `invalid var ${name}`);
  }
  for (const [name, value] of Object.entries(theme.colors)) {
    if (value === "" || typeof value === "number" || /^#[0-9a-f]{6}$/i.test(value)) continue;
    assert.ok(value in vars, `color ${name} references missing var ${value}`);
  }

  const colorReferences = new Set(Object.values(theme.colors));
  const unused = Object.keys(vars).filter(
    (name) => !colorReferences.has(name) && !paletteSource.includes(`resolve("${name}")`),
  );
  assert.deepEqual(unused, []);
});
