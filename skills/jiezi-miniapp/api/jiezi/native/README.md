# Bundled `jiezi/native` adapter

This is a self-contained copy of the JieZi adapter shipped for Native Shell
0.6.0. Read `index.d.ts` for exact props, events, data and ref types;
`package.json` records the Host contracts `jiezi.table@2` and
`jiezi.collection@1`.

For a newly initialized mini-app without an established SDK staging step, copy
this complete directory to `<project>/node_modules/jiezi/native`. The import is
then:

```tsx
import { NativeUITableView, NativeUICollectionView } from "jiezi/native";
```

`index.js` and `runtime.js` resolve the Host's `jiezi/native` UI set at runtime;
no app-side Rust/Cargo configuration or npm install is involved. In headless or
unsupported Hosts, use `host.params.components` feature detection and an NSH
fallback. See `../../../references/components.md` for examples.

These files are generated/packaged SDK artifacts. Do not edit their declarations
or runtime in the mini-app; report version or contract drift instead.
