# pi-cyber-ui

A standalone Pi package that bundles a cyber-inspired editor, compact footer, compact tool rendering, and lightweight working indicator together with a matching dark theme.

The visual direction was inspired by Tokyo Night, but this is a new project with its own palette, naming, and packaging structure.

The extension is split into small modules for easier maintenance:
- `editor.ts` wires editor/session events
- `cyber-editor.ts` owns the pure prompt shell and prompt marker
- `editor-state.ts` handles session state and token accounting
- `working.ts` renders prompt progress and idle summaries
- `footer.ts` renders cwd, git dirty state, model, thinking level, and context usage
- `tool-render.ts` renders compact built-in tool calls/results
- `tool-registry.ts` tracks tool lifecycle, durations, and per-turn tallies
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
- `extensions/pi-cyber-ui/tool-render.ts` — compact built-in tool renderer
- `extensions/pi-cyber-ui/tool-registry.ts` — tool timing/tally registry
- `extensions/pi-cyber-ui/path-utils.ts` — path display helpers

## Local development

```bash
cd ~/Developer/pi-cyber-ui
npm install
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

## Commands

This package does not register commands.

## Notes

- Package name: `pi-cyber-ui`
- Theme name: `cyber-ui-dark`
- Extension entrypoint: `extensions/pi-cyber-ui/index.ts`
- Exact streaming usage is protocol-aware; Anthropic Messages API can surface cumulative in-flight usage, while other APIs fall back to estimates
- Working indicator uses Pi's official `ctx.ui.setWorkingIndicator()` / `ctx.ui.setWorkingMessage()` APIs
- Built-in tools are re-registered for compact rendering while preserving their original execution behavior and prompt metadata
- Theme format follows the official Pi theme schema
