// The runtime half of the generated `jiezi/native` adapter. `index.js` is
// generated from the set's declarations and re-exports each component here.
//
// The host registers the UI set (`jiezi_init`) before it loads an app, so
// `nativeModule` returns the same values an import of the set would. A
// headless run (`nsh test`) has no host set: this module still loads, the
// components are inert, and the app can feature-detect
// `host.params.components` and render its own fallback.
//
// This file is hand-written; `index.js`, `index.d.ts`, `package.json` and the
// build scripts are the package's generated/owned files. See README.md.
import { host, nativeModule } from "nsh";

const components = Array.isArray(host?.params?.components)
  ? host.params.components
  : [];

let native = null;
try {
  native = nativeModule("jiezi/native");
} catch (error) {
  console.warn("jiezi/native: the host did not register the UI set", error);
}

let warned = false;
const inert = () => null;

/// The set's component `name`, or an inert component when the host has none.
export function component(name) {
  const value = native?.[name];
  if (value) return value;
  if (!warned && components.length > 0) {
    warned = true;
    console.warn(`jiezi/native: the host does not serve ${name}; rendering nothing`);
  }
  return inert;
}
