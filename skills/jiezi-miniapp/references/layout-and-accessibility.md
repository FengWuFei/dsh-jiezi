# Layout, keyboard, and visible-state patterns

The Host renders `env(...)` lengths on padding and margin. A screen that owns a
bottom input should reserve the keyboard inset itself; the default is not a
resize-and-scroll layout:

```tsx
<View
  style={{
    flex: 1,
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "calc(env(safe-area-inset-bottom) + env(keyboard-inset-height))",
  }}
>
  {/* header, content, input */}
</View>
```

Keep the focused input inside a `Scroll` or a bounded middle region; do not let
the keyboard push a fixed header off screen.

`Checkbox` is deliberately look-less: it owns the behavior, not a default
checkmark. Draw a visible indicator and hide its decorative glyph from assistive
technology:

```tsx
<Checkbox
  checked={done()}
  onChange={({ checked }) => done.set(checked)}
  indicatorStyle={{
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
    alignItems: "center", justifyContent: "center",
    backgroundColor: done() ? "#34c759" : "transparent",
    borderColor: done() ? "#34c759" : "#c7c7cc",
  }}
  indicator={
    <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700" }}
          accessibilityElementsHidden>
      ✓
    </Text>
  }
>
  <Text testID="task-label">买牛奶</Text>
</Checkbox>
```

`textDecorationLine: "line-through"` is declared by the TSX contract but is not
currently drawn by the iOS Host. For a completed task, use a muted color plus a
separate visible completion marker until the Host rendering is fixed.

A decorative `Text`/`View` (check glyph, status dot) should set
`accessibilityElementsHidden` or `importantForAccessibility="no"` so the row is
not read as `✓ 买牛奶`. Give the interactive row the single meaningful
`accessibilityLabel`.

Virtualized lists can keep recycled rows in the accessibility tree as hidden
nodes. `miniapp_ui` drops hidden duplicates of a visible testID and omits hidden
nodes by default; use `includeHidden: true` only when diagnosing the tree.
Still keep one unique, data-derived `testID` per visible row.
