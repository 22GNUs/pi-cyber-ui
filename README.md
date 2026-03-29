# pi-cyber-ui

A standalone Pi package that bundles a cyber-inspired editor, compact footer, and working animation together with a matching dark theme.

The visual direction was inspired by Tokyo Night, but this is a new project with its own palette, naming, and packaging structure.

The editor is split into small modules for easier maintenance:
- `editor.ts` wires events and the `/cyber-vim` toggle command
- `cyber-editor.ts` owns the cyber shell, prompt marker, and HUD chrome
- `vim-editor.ts` contains the standalone Vim behavior layer
- `editor-state.ts` handles session state and token accounting
- `editor-hud.ts` renders the HUD
- `token-usage.ts` contains protocol-aware exact/estimated token helpers

## Contents

- `themes/cyber-ui-dark.json` — Pi theme
- `extensions/pi-cyber-ui/index.ts` — extension entrypoint
- `extensions/pi-cyber-ui/editor.ts` — editor event wiring
- `extensions/pi-cyber-ui/editor-state.ts` — editor/session state
- `extensions/pi-cyber-ui/cyber-editor.ts` — Cyber editor shell
- `extensions/pi-cyber-ui/vim-editor.ts` — standalone Vim behavior layer
- `extensions/pi-cyber-ui/editor-hud.ts` — HUD rendering
- `extensions/pi-cyber-ui/token-usage.ts` — token usage helpers
- `extensions/pi-cyber-ui/footer.ts` — compact footer
- `extensions/pi-cyber-ui/working.ts` — working message animation

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

- `/cyber-vim` — toggle Vim mode on/off inside the cyber editor
- `/cyber-vim status` — show current Vim mode state
- Cyber UI settings are persisted to `~/.pi/agent/pi-cyber-ui.json`

Example settings:

```json
{
  "vimModeEnabled": true,
  "jjEscapeTimeoutMs": 250
}
```

- `jjEscapeTimeoutMs` controls the insert-mode `jj` window in milliseconds

## Notes

- Package name: `pi-cyber-ui`
- Theme name: `cyber-ui-dark`
- Extension entrypoint: `extensions/pi-cyber-ui/index.ts`
- Exact streaming usage is protocol-aware; Anthropic Messages API can surface cumulative in-flight usage, while other APIs fall back to estimates
- Theme format follows the official Pi theme schema
