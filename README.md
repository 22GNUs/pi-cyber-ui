# pi-cyber-ui

A standalone Pi package that bundles a cyber-inspired editor, compact footer, lightweight working indicator, and a matching dark theme.

The visual direction was inspired by Tokyo Night, but this is a new project with its own palette, naming, and packaging structure.

The extension is split into small modules for easier maintenance:
- `editor.ts` wires editor/session events
- `cyber-editor.ts` owns the prompt shell, prompt marker, dynamic border, and optional session name label
- `editor-state.ts` handles prompt-scoped token accounting and usage reconciliation
- `working.ts` renders prompt progress and idle summaries
- `footer.ts` renders cwd, git dirty state, model, thinking level, and context usage
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

## Architecture contract

`pi-cyber-ui` is UI-only. It does not register or re-register tools, replace tool renderers, change active tool sets, or modify tool arguments and results.

The extension observes tool lifecycle events only to reflect the current phase in its HUD. While a tool runs, the latest token and TPS values remain visible and dim; the tool itself is unchanged.

Pi built-in tools and third-party extension tools retain their owning definitions, execution behavior, and rendering. They may still use standard theme tokens such as `toolTitle`, `toolOutput`, tool-state backgrounds, and diff colors from `cyber-ui-dark`.

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
- Tool definitions, execution, and rendering remain owned by Pi or the extension that registered them
- Theme format follows the official Pi theme schema
