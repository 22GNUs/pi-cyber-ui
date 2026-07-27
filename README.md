# pi-cyber-ui

A standalone Pi package: cyber-inspired editor, compact footer, working indicator, neon tool gutter, and a matching Tokyo Night–derived dark theme.

## Design language

Visual reference lives in [`design/DESIGN.html`](design/DESIGN.html) (effect-first demos, not an architecture doc).

**Signal restraint.** Status lives in a static left bar (`▍`) on one slate panel (`#121218`):
- **blue** — running
- **teal** — success
- **red** — failure

No bar animation by design: bars are pure functions of tool state (zero timers, zero re-render churn). Motion feedback while running belongs to the working HUD, not the transcript.

**Cool Minimal fish roles.** Call-slot parsing follows the lexical roles of the [tokyonight fish theme](https://github.com/folke/tokyonight.nvim/blob/main/extras/fish_themes/tokyonight_night.theme), but secondary tokens use low-chroma theme colors:

| Token | Color | Used for |
|-------|-------|----------|
| tool name / `$` | cyan | component identity and shell prompt |
| shell command | dim cyan | command words |
| option / param | fgMuted | flags, paths, args, assignments |
| quote | silverDim | quoted strings and heredoc bodies |
| end | fgDim | `\|` `&&` `;` `&` |
| `$VAR` | tealDark | expansions |
| comment | fgDim | `# …` |

**Cold neon syntax.** Theme-wide: string → teal, number → pink, diff added → teal, code fence → blueDark. Orange is reserved for warnings and bash mode.

## Modules

| File | Role |
|------|------|
| `editor.ts` / `cyber-editor.ts` / `editor-state.ts` | Editor shell, prompt glyph, session label, token accounting |
| `working.ts` | Running HUD + idle summary (shared 60fps visual clock, color-gated) |
| `footer.ts` | Model · thinking · context · path · event-driven git dirty state |
| `tool-gutter.ts` | Static status bar + panel + built-in fish highlighting for every tool |
| `tool-renderer-bridge.ts` | Idempotent renderer middleware on the exact running Pi component |
| `user-message-patch.ts` | Prompt-style user messages (pink bar + silver `❯`) |
| `config.ts` | `~/.pi/agent/pi-cyber-ui.json` |
| `runtime-pi.ts` | Resolves modules from the exact Pi process loading the extension |
| `ui-metrics.ts` | Last rendered terminal width for responsive working-line fitting |
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
| `userMessageStyle` | `prompt` \| `block` | `prompt` | Pink gutter + silver `❯`, or themed background box |

Tool bar colors when `gutter`: pending → blue · success → teal · error → red. User transcript bars use pink (all static).

## Architecture contract

UI-only. Two rendering surfaces beyond widgets:

1. **Universal tool gutter** (`toolHighlight: "gutter"`) — guarded renderer-only middleware.
   - Loads `ToolExecutionComponent` from the exact Pi package running the process, never from the extension's local development dependency.
   - Wraps renderer resolution rather than registering same-name tools, so built-in, extension, SDK, and later dynamically registered tools all receive the same gutter shell.
   - Original `renderCall` / `renderResult`, `lastComponent`, shared renderer state, streaming, syntax, diffs, and expand/collapse behavior are retained.
   - Built-in calls keep fish recoloring; extension/SDK renderer colors remain owned by their original tool.
   - Execute functions, schemas, results, source ownership, and active tool sets are never modified.
   - The bridge is process-idempotent and restores Pi's original method descriptors on session shutdown/reload.
   - Readonly, frozen, conflicting, or structurally incompatible prototypes fail safe to Pi's themed block rendering and produce one TUI warning.
   - An individual owner renderer exception stays inside the gutter and uses Pi-equivalent raw call/result fallback content.
   - Rendering is stateless per row: the bar color derives from tool state only; no timers or animation loops.

2. **User message prompt style** (`userMessageStyle: "prompt"`) — a second defensive rendering patch.
   - Patches `UserMessageComponent.prototype.rebuild` after locating the running pi from `process.argv[1]`.
   - The patch is process-idempotent and restores Pi's original renderer on session shutdown/reload.
   - Structure-checked; any mismatch silently keeps the themed block style.
   - Message content, session data, and LLM context are never touched.

Dynamic tool registration requires no `/reload`: new rows pass through the already-installed renderer middleware while tool execution remains entirely owned by the registering extension or SDK caller.

The extension observes keyed `tool_execution_start/end` events only to drive the HUD phase. While any tool runs, token/TPS values freeze and dim; tools themselves are unchanged. Retry/compaction/follow-up runs share one prompt telemetry window and the summary appears only after `agent_settled`.

## Compatibility

Requires Pi packages `>=0.82.1`; future compatible Pi releases are loaded from the running process at runtime.

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
- Working HUD: one non-overlapping 16ms visual clock, letter-wave verb, dual-breath spinner, odometer/glow, freeze-fade during tools
- Idle summary: mounted once, then color-interpolated for its 600ms fade without rebuilding the widget tree
- Git dirty state: tool-event refresh plus a 60s external-change fallback (no shell process)
- Theme format follows the official Pi theme schema; all package colors derive from its `vars` via `palette.ts`
