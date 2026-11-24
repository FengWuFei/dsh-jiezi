# Mini-app source and capabilities

Read this for a new app, substantial UI work, unfamiliar Native Shell APIs,
persistence, or Host integration. For component/API discovery before a project
exists, use the skill's bundled [API snapshot](../api/README.md); it does not
depend on the current workspace. After initialization, the project's generated
types identify its actual pinned version.

## Project shape after initialization

Inspect at least:

```text
nsh.json             app id, name, version/build, entry/theme/capabilities
jiezi.json           library summary and capability purpose text
docs/about.md        关于 description (restricted Markdown)
assets/icon.png      optional 1024×1024 sRGB icon
App.tsx              default entry unless nsh.json says otherwise
tsconfig.json        project TypeScript/JSX configuration
.nsh/types/          generated Native Shell and installed-set declarations
pages/, components/  existing organization when present
*test*               existing local behavioral checks
```

Do not edit `.nsh` generated files. `miniapp({ action: "build" })` accepts
`projectId` and an optional `projectDir`; the bridge resolves the default from
its configured project root and rejects directories outside it. Keep source
separate from bridge artifacts, state, keys, and DSH configuration.

## API and state discipline

Native Shell TSX is not web React or React Native. Read the relevant bundled
`api/nsh/` declaration before using unfamiliar APIs; after initialization, check
the project's `.nsh/types/nsh/` for version differences. Reuse the project's
existing patterns for `mount`, components, navigation, theme tokens, light/dark
appearance, safe areas, and scrolling.

Create reactive values with `signal`; derive values with the project's existing
`computed` pattern. Read signals by calling them and write with `.set()` or
`.update()`. Replace arrays/objects with new values rather than assuming an
in-place mutation triggers rendering. Keep large screens and host/storage logic
in focused local modules instead of expanding the entry indefinitely.

A minimal entry has this shape; adapt it rather than replacing an existing app:

```tsx
import { Text, View, mount, signal } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View testID="screen-counter" style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text testID="counter-value">{count()}</Text>
      <View
        role="button"
        testID="counter-increment"
        accessibilityLabel="Increment"
        onPress={() => count.update((value) => value + 1)}
      >
        <Text>Increment</Text>
      </View>
    </View>
  );
}

mount(App);
```

## Build semantics into the UI

Automation needs stable observation, not coordinates or arbitrary sleeps:

- Name screens, controls, inputs, and results consistently, for example
  `screen-counter`, `counter-increment`, `field-task-title`,
  `action-save-task`, and `status-save-error`.
- Use stable data ids for dynamic rows, never array positions. Add roles and
  accessible labels where supported.
- Expose ready/loading/success/empty/error as text or semantic nodes; do not
  communicate a required result by color alone.
- Prevent conflicting pending actions and handle invalid, empty, long, or
  repeated input when relevant to the request.
- Preserve existing appearance, safe-area, and scrolling conventions; do not
  assume one screen size.

Run the project's established tests/static checks if present. Do not install a
generic test stack or rewrite generated configuration just to obtain a check.
The JieZi build and device loop remain required for delivery claims.

## Capabilities and Host integration

`nsh.json` is the app identity and capability boundary. Declare only what the
implementation uses. Declaration does not prove a runtime permission was
granted, and refusal is not a reason to search for a bypass.

Capability values keep Native Shell shapes: booleans (`"clipboard": true`),
objects (`"openUrl": { "schemes": [...] }`), arrays (`"host": [...]`), or
`"host": true`. Every declared sensitive capability (`clipboard`, `picker`,
`share`, `speech`, `notifications`) also needs purpose text in `jiezi.json`; the
signed outer manifest carries the declaration and purposes for display only.
Read [presentation-and-package.md](presentation-and-package.md) before authoring
or changing those files.

Use Native Shell storage APIs already available in the project for ordinary
data. Use `host.call` only for an exact contract exposed by the installed Host
and project types; never invent method names, parameters, grants, or wire ids.
Do not assume arbitrary console output is captured: use returned diagnostics
and the project's existing explicit diagnostics bridge, if any.

Import supported Host UI from `jiezi/native`; read
[components.md](components.md) and the staged adapter's `index.d.ts` for exact
usage. App-facing view names follow `Native` + UIKit class, such as
`NativeUITableView`; wire ids remain separate contracts. Check `host.params.components` and retain the project's established
fallback when a component is optional or unavailable in headless tests.

The reviewed Host components (`NativeUITableView`,
`NativeUICollectionView`) are registered by current Hosts and need no per-app
grant. A new native component or permission requires a Host release and explicit
user approval. Do not imitate it with private Host calls, Swift in the mini-app, or
an unrequested dependency. Never put provider credentials, pairing codes,
tokens, private keys, or signing material in source, metadata, diagnostics,
screenshots, or logs.
