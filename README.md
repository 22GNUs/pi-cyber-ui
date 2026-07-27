# pi-cyber-ui

A standalone Pi package: cyber-inspired editor, compact footer, working indicator, neon tool gutter, and a matching Tokyo Night–derived dark theme.

## Design language

Visual reference lives in [`design/DESIGN.html`](design/DESIGN.html) (effect-first demos, not an architecture doc).

**Signal restraint.** Status lives in a static left bar (`▍`) on one slate panel (`#121218`):
- **blue** — running
- **teal** — success
- **red** — failure

No bar animation by design: bars are pure functions of tool state (zero timers, zero re-render churn). Motion feedback while running belongs to the working HUD, not the transcript.

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
| `tool-gutter.ts` | Built-in tool wrap: static status bar + panel + fish highlighting |
| `user-message-patch.ts` | Prompt-style user messages (`❯` + silver bar) |
| `config.ts` | `~/.pi/agent/pi-cyber-ui.json` |
| `runtime-pi.ts` | Resolves modules from the exact Pi process loading the extension |
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
  "userMessageStyle": "prompt"
}
```

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `toolHighlight` | `gutter` \| `blocks` | `gutter` | Status bar + panel, or pi’s default block shell |
| `userMessageStyle` | `prompt` \| `block` | `prompt` | `❯` + silver gutter, or themed background box |

Bar colors when `gutter`: pending → blue · success → teal · error → red (all static).

## Architecture contract

UI-only. Two rendering surfaces beyond widgets:

1. **Built-in tool gutter** (`toolHighlight: "gutter"`) — guarded official override pattern.
   - Loads `create*ToolDefinition` from the exact Pi package running the process, never from the extension's local development dependency.
   - Wraps a tool only while Pi still reports its source as `builtin`; same-name extension / SDK tools retain their behavior and rendering.
   - Only the shell is replaced (`renderShell: "self"` + bar + panel). Built-in `renderCall` / `renderResult` (syntax, diffs, expand) are reused.
   - Args, results, and active tool sets are never modified. Wrapped built-ins are reported by Pi as extension-owned overrides.
   - Pi prints its standard override warning for each wrapped tool at startup — expected.
   - Active extension tools that cannot receive the gutter produce one warning on startup / reload, then keep their themed block fallback.
   - Rendering is stateless per row: the bar color derives from tool state only; no timers or animation loops.

2. **User message prompt style** (`userMessageStyle: "prompt"`) — the only deliberate hack.
   - Patches `UserMessageComponent.prototype.rebuild` after locating the running pi from `process.argv[1]`.
   - Structure-checked; any mismatch silently keeps the themed block style.
   - Message content, session data, and LLM context are never touched.

Third-party extension tools cannot be wrapped (definitions not reachable via the extension API). They keep pi’s original rendering; default block shells are styled by `cyber-ui-dark` tool-state backgrounds on the same panel tone.

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
