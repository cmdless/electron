# @cmdless/ui

One-shot commands for cmdless UI. Each shows one thing on a host (through `UIHost` from [`@cmdless/ui-sdk`](../../packages/ui-sdk)), prints the value it ended with, and exits.

```
npx @cmdless/ui window url https://example.com
npx @cmdless/ui dialog question "Deploy to production?" --detail "3 services will restart." --button Deploy --button Cancel --cancel 1 --checkbox "Don't ask again"
npx @cmdless/ui card samples/approval.card.json
npx @cmdless/ui form samples/settings.schema.json --ui-schema samples/settings.ui.json --data samples/settings.data.json
npx @cmdless/ui elicit samples/elicitation.json
npx @cmdless/ui permission samples/permission.json
```

- `window <url|file> <source>` — show a window, and print the value it ends with (its renderer's resolve, or the URL a `--redirect` caught). Options: `--width`, `--height`, `--redirect`, `--external`, `--title`.
- `dialog <type> <message>` — show a message box, and print what was chosen: `{ response, checkboxChecked }`, where `response` is the button's index. `--detail` adds smaller text under the message, `--button <label>` (repeated) sets the buttons in order (just OK without any), `--default`/`--cancel <index>` pick what Enter and Escape choose, and `--checkbox <label>` (with `--checked` to start it ticked) adds a checkbox.
- `card <file>` — show an [Adaptive Card](https://adaptivecards.io) (already expanded: no `${}` bindings), and print the `Action.Submit` chosen on it as JSON (`{ action, inputs }`); closing it prints nothing and exits 1. Links open in the browser; `Action.Execute` (an event for a long-lived card, through `UIHost`) isn't printed. Options: `--host-config`, `--width`, `--height`, `--title`.
- `form <schema>` — show a JSON Schema form ([react-jsonschema-form](https://rjsf-team.github.io/react-jsonschema-form/), in Mantine), and print the data it was submitted with; cancelling prints nothing and exits 1. Options: `--ui-schema`, `--data`, `--submit-text`, `--width`, `--height`, `--title`.
- `elicit <file>` — ask an elicitation (MCP's or ACP's, form mode: `{ message, requestedSchema }`) as a card with the schema as a form, and print its result: `{ action: "accept", content }`, `{ action: "decline" }`, or `{ action: "cancel" }` if it's closed.
- `permission <file>` — ask a permission request (ACP's: `{ title, description?, options: [{ optionId, name, kind }] }`) as a card with a button per option, and print its outcome: `{ outcome: "selected", optionId }`, or `{ outcome: "cancelled" }` if it's closed.

Both take `--app <name>` to show it on that app's host (joined if it's already running), plus `--root` and `--timeout`. Without `--app`, each runs on a throwaway host of its own.

`launch install`, `launch add <file>` and `launch open <file>` run [ui-runtime's launcher commands](../ui-runtime#the-launcher) with the runtime this package speaks to, from the cmdless root's cache: `npx @cmdless/ui launch install` sets up opening `.cmdless` files on this machine.

`package <specifier> [args...]` caches and runs a different package's bin instead, passing the rest of the arguments on:

```
npx @cmdless/ui package some-other-cli@1.2.3 --some-flag
```

Packages are cached under `~/.cmdless` (or `$CMDLESS_ROOT`) on first use and reused on subsequent runs.
