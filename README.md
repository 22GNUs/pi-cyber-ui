# pi-cyber-ui

A standalone Pi package that bundles a cyber-inspired editor, compact footer, and working animation together with a matching dark theme.

The visual direction was inspired by Tokyo Night, but this is a new project with its own palette, naming, and packaging structure.

## Contents

- `themes/cyber-ui-dark.json` — Pi theme
- `extensions/pi-cyber-ui/index.ts` — extension entrypoint
- `extensions/pi-cyber-ui/editor.ts` — custom editor
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

## Notes

- Package name: `pi-cyber-ui`
- Theme name: `cyber-ui-dark`
- Extension entrypoint: `extensions/pi-cyber-ui/index.ts`
- Theme format follows the official Pi theme schema
