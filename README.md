# pi-cyber-ui

A standalone Pi package that bundles a cyber-inspired editor, compact footer, lightweight working indicator, and a matching dark theme.

The visual direction was inspired by Tokyo Night, but this is a new project with its own palette, naming, and packaging structure.

The extension is split into small modules for easier maintenance:
- `editor.ts` wires editor/session events
- `cyber-editor.ts` owns the prompt shell, prompt marker, dynamic border, and optional session name label
- `editor-state.ts` handles prompt-scoped token accounting and usage reconciliation
- `working.ts` renders prompt progress and idle summaries
- `footer.ts` renders cwd, git dirty state, model, thinking level, and context usage
- `tool-gutter.ts` wraps built-in tools with a status gutter bar (block-free)
- `user-message-patch.ts` renders user messages as `❯` prompt lines (defensive patch)
- `config.ts` loads `~/.pi/agent/pi-cyber-ui.json`
- `path-utils.ts` contains shared path shortening/styling helpers
- `token-usage.ts` contains protocol-aware exact/estimated token helpers

## Contents

- `themes/cyber-ui-dark.json` — Pi theme
- `extensions/pi-cyber-ui/index.ts` — extension entrypoint
- `extensions/pi-cyber-ui/editor.ts` — editor/session event wiring
- `extensions/pi-cyber-ui/editor-state.ts` — editor/session state
- `extensions/pi-cyber-ui/cyber-editor.ts` — Cyber editor shell
- `extensions/pi-cyber-ui/token-usage.ts` — token usage helpers
- `extensions/pi-cyber-ui/footer.ts` — compact footer
- `extensions/pi-cyber-ui/working.ts` — working line and idle summary widget
- `extensions/pi-cyber-ui/tool-gutter.ts` — built-in tool gutter rendering
- `extensions/pi-cyber-ui/user-message-patch.ts` — prompt-style user messages
- `extensions/pi-cyber-ui/config.ts` — user configuration
- `extensions/pi-cyber-ui/path-utils.ts` — path display helpers

## Local development

```bash
cd ~/Developer/pi-cyber-ui
npm install
npm test
npm run typecheck
```

## Using with Pi

Install from the remote repository:

```bash
pi install git:github.com/22GNUs/pi-cyber-ui.git
```

For local development, you can also install from a local checkout path:

```bash
pi install /path/to/pi-cyber-ui
```

The package is structured to be publishable later via git or npm without changing the directory layout.

When it is published, install it with one of these forms:

```bash
pi install npm:pi-cyber-ui
# or
pi install git:github.com/22GNUs/pi-cyber-ui.git
```

## Configuration

Optional file: `~/.pi/agent/pi-cyber-ui.json`. Missing file or fields fall back to defaults. Edit and run `/reload` to apply.

```json
{
  "toolHighlight": "gutter",
  "userMessageStyle": "prompt",
  "gutterAnimation": true
}
```

- `toolHighlight` — `"gutter"` (default) wraps the 7 built-in tools with a left status bar on a uniform slate panel: pending = cyan (breathing), success = tealDark (with a phase-continuous power-down fade), error = red. `"blocks"` keeps pi's default background-block shell.
- `userMessageStyle` — `"prompt"` (default) renders user messages as block-free `❯` prompt lines with a silver gutter. `"block"` keeps the themed background box.
- `gutterAnimation` — animates the gutter bar while a tool is running.

## Architecture contract

`pi-cyber-ui` is UI-only with two rendering surfaces beyond widgets:

- **Built-in tool gutter** (`toolHighlight: "gutter"`) uses pi's official wrap pattern: same-name registrations whose `execute` delegates 1:1 to the built-in implementations obtained at runtime (`create*ToolDefinition`), so tool behavior always follows the installed pi version. Only the shell is replaced (`renderShell: "self"` + a line-prefix gutter); built-in `renderCall`/`renderResult` — syntax highlighting, diffs, expand/collapse — are reused as-is. Tool arguments, results, and active tool sets are never modified. Pi prints its standard override warning for each wrapped tool at startup; this is expected.
- **User message prompt style** (`userMessageStyle: "prompt"`) is a deliberate, defensive render patch of a core component that has no extension hook. It verifies pi's internal structure before patching and silently falls back to the themed block style on any mismatch. Message content, session data, and LLM context are never touched.

Third-party extension tools cannot be wrapped (their definitions are not reachable through the extension API); they keep pi's default block shell, styled by `cyber-ui-dark` tool-state backgrounds.

The extension observes tool lifecycle events only to reflect the current phase in its HUD. While a tool runs, the latest token and TPS values remain visible and dim; the tool itself is unchanged.

## Commands

- Pi's built-in `/name <name>` sets the session display name. When present, `pi-cyber-ui` shows it in the editor's top-right border as `⟦ name ⟧`.

## Notes

- Package name: `pi-cyber-ui`
- Theme name: `cyber-ui-dark`
- Extension entrypoint: `extensions/pi-cyber-ui/index.ts`
- Telemetry is prompt-scoped: text, thinking, and tool-call deltas contribute to the same live output total across all turns
- `~` marks provisional output/rate values; trusted cumulative or final usage removes it, while missing final usage stays explicitly estimated
- Input totals are shown only when every turn supplied trustworthy input usage
- `t/s` is cumulative prompt output divided by assistant-response wall time; thinking is included and tool execution time is excluded
- Working telemetry preserves the original breathing dot, ambient verb, colors, integer-second clock, and 16ms animation refresh; tool execution freezes and dims the latest in/out/tps values
- Theme format follows the official Pi theme schema
