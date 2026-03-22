# AGENTS.md

Concise working notes for this repository.

## Scope
- This repo contains a standalone Pi package: theme + extensions.
- Keep edits small and focused.
- Match the existing language of the file you are editing.

## Structure
- `themes/` — Pi theme files
- `extensions/pi-cyber-ui/` — extension entrypoint and UI modules
- Token/streaming logic lives in `extensions/pi-cyber-ui/token-usage.ts`
- Editor state lives in `extensions/pi-cyber-ui/editor-state.ts`
- HUD rendering lives in `extensions/pi-cyber-ui/editor-hud.ts`

## Workflow
- Use `npm run typecheck` after code changes.
- Update `README.md` when public structure or usage changes.
- Prefer small, surgical edits over rewrites.

## Communication
- Use Simplified Chinese for explanations by default.
- Use English for code, identifiers, and file content when the file is English.
