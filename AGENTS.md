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
- Working/HUD rendering lives in `extensions/pi-cyber-ui/working.ts`

## Workflow
- Design-first for UI changes: update `design/DESIGN.html` before implementation, let the user review the visual/design effect, then implement only after explicit approval.
- Before changing any code, confirm `design/DESIGN.html` is current and explicitly user-approved for review.
- Keep code changes synchronized with `design/DESIGN.html`.
- `design/DESIGN.html` is an effect-first visual reference: render every visible surface (palette / components / motion / color scales) as live demos with minimal one-line notes; add a demo for any new UI surface before coding it; keep out implementation details, engineering invariants, file maps, architecture notes, and changelog-style prose.
- Colors must not be hardcoded as scattered RGB tables in individual modules — all UI colors go through `extensions/pi-cyber-ui/palette.ts`, which derives them from `themes/cyber-ui-dark.json` `vars` as the single source.
- Use `npm run typecheck` after code changes.
- Update `README.md` when public structure or usage changes.
- Prefer small, surgical edits over rewrites.

## Communication
- Use Simplified Chinese for explanations by default.
- Use English for code, identifiers, and file content when the file is English.
