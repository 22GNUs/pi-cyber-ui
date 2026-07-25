# pi-cyber-ui

A standalone Pi package: cyber-inspired editor, compact footer, working indicator, neon tool gutter, and a matching Tokyo Night–derived dark theme.

## Design language

Visual reference lives in [`design/DESIGN.html`](design/DESIGN.html) (effect-first demos, not an architecture doc).

**Signal restraint.** The whole UI keeps two status hues:
- **cyan** — active / running (neon breathing)
- **red** — failure

Everything else is structure: a single slate panel (`#121218`), luminance steps for hierarchy, and a left status bar (`▍`) whose color *is* the signal. Success does not invent a third status hue — the bar settles to neon **teal** after a short “settle blink” (flash to `cyanBright`, ease down).

**Fish shell isomorphism.** Call-slot text follows the [tokyonight fish theme](https://github.com/folke/tokyonight.nvim/blob/main/extras/fish_themes/tokyonight_night.theme) (params customized to pink):

| Token | Color | Used for |
|-------|-------|----------|
| command | cyan | tool names, bash commands, `$` prompt |
| option / param | pink | flags, paths, args |
| quote | orange | quoted strings |
| end | orange | `\|` `&&` `;` `&` |
| `$VAR` | green | expansions |
| comment | fgDim | `# …` |

**Cold neon syntax.** Theme-wide: string → teal, number → pink, diff added → teal, code fence → blueDark. Orange is reserved for warning / bash mode / fish quotes.

## Modules

| File | Role |
|------|------|
| `editor.ts` / `cyber-editor.ts` / `editor-state.ts` | Editor shell, prompt glyph, session label, token accounting |
| `working.ts` | Running HUD + idle summary (60fps, color-gated) |
| `footer.ts` | Model · thinking · context · path · git |
| `tool-gutter.ts` | Built-in tool wrap: neon bar + panel + fish highlighting |
| `user-message-patch.ts` | Prompt-style user messages (`❯` + silver bar) |
| `config.ts` | `~/.pi/agent/pi-cyber-ui.json` |
| `palette.ts` | Single source of RGB colors from the theme JSON |
| `path-utils.ts` / `token-usage.ts` / `format.ts` | Shared helpers |

## Contents

- `themes/cyber-ui-dark.json` — Pi theme (vars + tokens)
- `extensions/pi-cyber-ui/` — extension entrypoint and modules
- `design/DESIGN.html` — live visual reference

## Configuration

Optional: `~/.pi/agent/pi-cyber-ui.json`. Missing file/fields fall back to defaults. Edit and `/reload`.

```json
{
  "toolHighlight": "gutter",
  "userMessageStyle": "prompt",
  "gutterAnimation": true
}
```

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `toolHighlight` | `gutter` \| `blocks` | `gutter` | Neon status bar + panel, or pi’s default block shell |
| `userMessageStyle` | `prompt` \| `block` | `prompt` | `❯` + silver gutter, or themed background box |
| `gutterAnimation` | boolean | `true` | Pending breath + settle blink |

Bar colors when `gutter`:
- pending → cyan neon breath (shallow valley, 60fps, color-change gated)
- success → teal, via settle blink (140ms flash to cyanBright → ease-out 760ms)
- error → red (immediate)

## Architecture contract

UI-only. Two rendering surfaces beyond widgets:

1. **Built-in tool gutter** (`toolHighlight: "gutter"`) — official wrap pattern.
   - Registers same-name tools whose `execute` is the runtime built-in (`create*ToolDefinition`), so behavior tracks the installed pi.
   - Only the shell is replaced (`renderShell: "self"` + bar + panel). Built-in `renderCall` / `renderResult` (syntax, diffs, expand) are reused.
   - Args, results, and active tool sets are never modified.
   - Pi prints its standard override warning for each wrapped tool at startup — expected.
   - Animation: one 16ms sampling loop per tool row, re-renders only when the quantized bar color changes; animation frames preserve inner render caches.

2. **User message prompt style** (`userMessageStyle: "prompt"`) — the only deliberate hack.
   - Patches `UserMessageComponent.prototype.rebuild` after locating the running pi from `process.argv[1]`.
   - Structure-checked; any mismatch silently keeps the themed block style.
   - Message content, session data, and LLM context are never touched.

Third-party extension tools cannot be wrapped (definitions not reachable via the extension API). They keep pi’s default block shell, styled by `cyber-ui-dark` tool-state backgrounds on the same panel tone.

The extension observes tool lifecycle events only to drive the HUD phase. While a tool runs, token/TPS values freeze and dim; tools themselves are unchanged.

## Local development

```bash
cd ~/Developer/pi-cyber-ui
npm install
npm test
npm run typecheck
```

## Using with Pi

```bash
pi install git:github.com/22GNUs/pi-cyber-ui.git
# or, for a local checkout:
pi install /path/to/pi-cyber-ui
```

Select theme `cyber-ui-dark` via `/settings`.

## Commands

- Pi’s built-in `/name <name>` sets the session display name; when present, the editor’s top-right border shows `⟦ name ⟧`.

## Notes

- Package / theme / entrypoint: `pi-cyber-ui` · `cyber-ui-dark` · `extensions/pi-cyber-ui/index.ts`
- Telemetry is prompt-scoped across text / thinking / tool-call deltas
- `~` marks provisional output/rate; trusted final usage clears it
- Working HUD: 16ms refresh, letter-wave verb, dual-breath spinner, freeze-fade during tools
- Theme format follows the official Pi theme schema; all package colors derive from its `vars` via `palette.ts`
