# Component catalog and usage

Read this before choosing UI, navigation, input, dialog, list, or native Host
components. **Everything needed for discovery and exact API reading is bundled
with this skill; no existing project or repository checkout is required.**

Component knowledge has three distinct layers:

1. **This catalog** helps locate a candidate; it is not proof that a particular
   Host supports it.
2. **The bundled API snapshot** provides the exact pinned Native Shell 0.6.0 and
   JieZi adapter 0.2.0 props, data, events, refs, and doc comments. Never guess
   props from React Native, DOM, or UIKit. After a project exists, its generated
   declarations can reveal a different pinned version; identify and reconcile
   that difference instead of silently mixing contracts.
3. **Host feature detection** decides whether a `jiezi.*` component is available
   at runtime. A packaged adapter existing at build time does not mean every
   Host registers the component.

## Locate exports and exact APIs without a project

All paths below belong to this skill, not the user's workspace. Resolve them
against the skill's returned `resourceBase.path`; in shell examples,
`$SKILL_DIR` means that literal path, not an environment variable to look up.

- [Snapshot guide](../api/README.md)
- Core: [index.d.ts](../api/nsh/index.d.ts), [types.d.ts](../api/nsh/types.d.ts)
- Base: [base.d.ts](../api/nsh/base.d.ts)
- Mobile: [mobile.d.ts](../api/nsh/mobile.d.ts)
- JieZi: [index.d.ts](../api/jiezi/native/index.d.ts),
  [adapter package.json](../api/jiezi/native/package.json)

Use filesystem search or these read-only commands after substituting the actual
skill directory:

```sh
grep -nE '^export declare (function|const) [A-Z]' \
  "$SKILL_DIR/api/nsh/index.d.ts" "$SKILL_DIR/api/nsh/base.d.ts" \
  "$SKILL_DIR/api/nsh/mobile.d.ts"

grep -nE '^export (declare )?(const|function) [A-Z]' \
  "$SKILL_DIR/api/jiezi/native/index.d.ts"
```

Then read focused ranges around the component and its adjacent `Props`, data,
event, and ref types. Do not inject the large declaration files wholesale.

## Native Shell component modules

| Import | Useful exports | Typical role |
|---|---|---|
| `nsh` | `View`, `Text`, `Image`, `Scroll`, `List`, `Overlay`, `Canvas`, `ErrorBoundary` | Layout, content, scrolling, virtualized data, overlays and rendering primitives |
| `nsh/base` | `Button`, `Input`, `NavStack`, `NavPage`, `Dialog`, `AlertDialog`, `Sheet`, `Tabs`, `Select`, `Checkbox`, `RadioGroup`, `Slider`, `Progress`, `Table`, `DataTable`, `Toast` | Controls, native navigation, modal surfaces and higher-level UI |
| `nsh/mobile` | `TabBar`, `SegmentedControl`, `Switch`, `DateTimePicker` | iOS/mobile-native controls; read platform notes before use |
| `jiezi/native` | `NativeUITableView`, `NativeUICollectionView` | Current JieZi Host UI set; details below |

These are orientation, not an exhaustive allowlist. The generated module may
contain additional exports and platform-specific limitations. Prefer core `nsh`
primitives for simple layout, virtualized `List` for large homogeneous data,
`NavStack`/`NavPage` for navigation, and native Host components only when their
UIKit behavior is actually required.

### Example: core + base + mobile

```tsx
import { Text, View, signal } from "nsh";
import { Button, Input } from "nsh/base";
import { Switch } from "nsh/mobile";

function Settings() {
  const name = signal("");
  const enabled = signal(false);
  return (
    <View testID="screen-settings" style={{ flex: 1, padding: 20, gap: 12 }}>
      <Input testID="field-name" value={name()} onChange={({ value }) => name.set(value)} />
      <Switch checked={enabled()} onChange={({ checked }) => enabled.set(checked)} />
      <Button testID="action-save" onPress={() => { /* validate/save */ }}>
        <Text>Save</Text>
      </Button>
    </View>
  );
}
```

The corresponding exact declarations are in the bundled Base/Mobile snapshot:
`InputProps`, `SwitchProps`, and `ButtonProps`. Read those entries for more
behavior; no project-generated files are needed.

## Current JieZi Host components

The bundled [adapter manifest](../api/jiezi/native/package.json) records
`jiezi.hostComponents`. Its present contracts are:

| TSX export | Wire/version | Purpose |
|---|---|---|
| `NativeUITableView` | `jiezi.table@2` | Typed sections/rows, styles, icons/accessories, selection, editing/reorder, swipe actions, refresh, load-more, empty state, section index and scroll refs |
| `NativeUICollectionView` | `jiezi.collection@1` | Grids and carousel rails, tile/row cells, selection, visibility, refresh, empty state and Host commands |

Both are leaf native views: give them `style={{ flex: 1 }}` or another bounded
box and put NSH chrome around them, not children inside them. Their data is
owned by the app; events report interactions and the app sends updated data.

`miniapp_init` already stages this adapter. Only for a manually initialized
project with no established staging step, copy the skill's complete
`api/jiezi/native/` directory to
`<project>/node_modules/jiezi/native`. This is the plugin-provided adapter, not
an npm install, and it includes the runtime JavaScript as well as declarations.
Do not add Rust/Cargo metadata to the app.

### Detect availability and provide a fallback

```tsx
import { host } from "nsh";

const components: string[] = Array.isArray(host.params.components)
  ? host.params.components as string[]
  : [];
const hasTable = components.some(
  (name) => name === "jiezi.table" || name.startsWith("jiezi.table@"),
);
```

Check the expected contract version when compatibility matters. Use the
project's existing `If`/fallback pattern when the component is unavailable,
especially under headless `nsh test`. Do not treat `miniapp_ui.capabilities`
as this list: those values describe automation actions such as `tap`/`type`.

### `NativeUITableView`: structured data

```tsx
import {
  NativeUITableView,
  type NativeUITableViewSection,
} from "jiezi/native";

const sections: NativeUITableViewSection[] = [{
  title: "People",
  rows: [{ id: "u1", title: "Lin", subtitle: "Product", accessory: "disclosure" }],
}];

<NativeUITableView
  testID="people-table"
  style={{ flex: 1 }}
  sections={sections}
  tableStyle="insetGrouped"
  cellStyle="subtitle"
  onSelect={({ id }) => { /* open id */ }}
/>
```

Read `NativeUITableViewProps` for controlled selection/refresh and load-more;
read `NativeUITableViewRef` for `scrollToTop`/`scrollToRow`. Give rows stable
unique ids and add semantic fallback/testIDs around the native leaf.

### `NativeUICollectionView`: check the adapter's JSON props

The current typed adapter declares `sections: string` and
`emptyState?: string | null`; do not copy the table's structured-array usage:

```tsx
import { NativeUICollectionView } from "jiezi/native";

const sections = JSON.stringify([{
  id: "main",
  layout: "grid",
  columns: 2,
  items: [{ id: "a", title: "Alpha", icon: "star" }],
}]);

<NativeUICollectionView
  testID="feature-grid"
  style={{ flex: 1 }}
  sections={sections}
  onSelect={({ id }) => { /* open id */ }}
/>
```

For ref commands or a richer typed shape, use the documented
`nativeComponent("jiezi.collection", …)` form and mirror the exact wire
contract. Do not assume the adapter forwards every ref command. Read the bundled
adapter declaration before choosing between these forms; an existing project
may provide its own wrapper to reuse.

## Verification

Build first, then deploy and use `miniapp_ui`/`miniapp_action` to verify visible
results. Native UIKit internals may expose fewer semantic nodes than NSH
fallbacks, so place observable screen/status/chrome testIDs around the leaf.
A `host-component` failure means rechecking actual support and wire compatibility,
not retrying unchanged props or inventing a replacement Host call.
