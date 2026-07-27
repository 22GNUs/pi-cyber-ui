import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { parseGitStatus, sanitizeStatusText } from "../.test-dist/pi-cyber-ui/footer.js";
import { mix, palette, rgb } from "../.test-dist/pi-cyber-ui/palette.js";
import { shortenPathToWidth } from "../.test-dist/pi-cyber-ui/path-utils.js";
import { StreamingTokenEstimator } from "../.test-dist/pi-cyber-ui/token-usage.js";
import { highlightShellCommand } from "../.test-dist/pi-cyber-ui/tool-gutter.js";

test("footer status text stays single-line and git counts remain compact", () => {
  assert.equal(sanitizeStatusText("  build\nready\t now  "), "build ready now");
  assert.deepEqual(parseGitStatus("?? new.ts\n M changed.ts\nD  old.ts\n"), {
    added: 1,
    modified: 1,
    deleted: 1,
  });
});

test("streaming token estimation preserves lexical boundaries across chunks", () => {
  const split = new StreamingTokenEstimator();
  split.add("hel");
  split.add("lo world");

  const whole = new StreamingTokenEstimator();
  whole.add("hello world");
  assert.equal(split.value(), whole.value());

  const shortWords = new StreamingTokenEstimator();
  shortWords.add("a b c");
  assert.equal(shortWords.value(), 3);

  const unicode = new StreamingTokenEstimator();
  unicode.add("你好🙂");
  assert.ok(unicode.value() >= 4);
});

test("path shortening honors terminal cell width for Unicode paths", () => {
  for (const width of [1, 6, 12, 20]) {
    const result = shortenPathToWidth("~/开发/very-long🙂/project", width);
    assert.ok(visibleWidth(result) <= width);
  }
});

test("fish highlighting stays low-chroma while preserving lexical roles", () => {
  const commandColor = rgb(mix(palette.fgDim, palette.cyan, 0.65));
  const highlighted = highlightShellCommand("echo foo#bar | cat $HOME");
  assert.ok(highlighted.includes(`${commandColor}echo`));
  assert.ok(highlighted.includes(`${rgb(palette.fgMuted)}foo#bar`));
  assert.ok(!highlighted.includes(`${rgb(palette.fgDim)}#bar`));
  assert.ok(highlighted.includes(`${rgb(palette.fgDim)}|`));
  assert.ok(highlighted.includes(`${commandColor}cat`));
  assert.ok(highlighted.includes(`${rgb(palette.tealDark)}$HOME`));

  const wrapped = highlightShellCommand("sudo -u root env CI=1 bash -lc 'echo ok'");
  assert.ok(wrapped.includes(`${commandColor}sudo`));
  assert.ok(wrapped.includes(`${rgb(palette.fgMuted)}-u`));
  assert.ok(wrapped.includes(`${rgb(palette.fgMuted)}root`));
  assert.ok(wrapped.includes(`${commandColor}env`));
  assert.ok(wrapped.includes(`${commandColor}bash`));
  assert.ok(wrapped.includes(`${rgb(palette.silverDim)}'echo ok'`));
});

test("heredoc detection ignores quoted lookalikes", () => {
  const quoted = highlightShellCommand("echo '<<EOF'\nnext");
  const commandColor = rgb(mix(palette.fgDim, palette.cyan, 0.65));
  assert.ok(quoted.includes(`${commandColor}next`));

  const heredoc = highlightShellCommand("cat <<'EOF'\nbody\nEOF");
  assert.ok(heredoc.includes(`${rgb(palette.silverDim)}body`));
});
