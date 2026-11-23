---
name: jiezi-miniapp
description: Develop, modify, build, deploy, and debug JieZi Native Shell mini-apps (芥子小程序) using TSX and miniapp_* tools. Use for 创建/开发/修改/调试/构建/部署/验证芥子小程序, screens, reactive state, storage, declared native components, and compile/runtime/device failures in 芥子开发模式. Not for changing the iOS Host, bridge, signing system, or adding unsupported native capabilities.
---

# JieZi mini-app development

Deliver a working Native Shell app and verify the user's flow on the intended
paired device. Source edits or compilation alone are not delivery. Use standard
coding tools for source work and `miniapp_*` tools for authoritative build,
install, launch, observation, and diagnostic results.

## Boundaries

- Stay inside the configured project root and preserve its Native Shell
  template. Do not add npm dependencies, React Native/DOM code, native code,
  another package manager, or a second toolchain.
- Do not edit bridge state, DSH profiles, signing material, generated `.nsh`
  files, or files outside the project. Never seek or embed credentials.
- Use only capabilities and Host contracts the installed app actually supports.
  New native capabilities require a Host release and explicit user approval.
- Keep the existing app id and unrelated working code unless the task requires
  a different app. Do not bypass permission, pairing, or signature refusals.

## Procedure

### 1. Inspect and define one acceptance flow

When a project exists, read `nsh.json`, its entry TSX (normally `App.tsx`),
`tsconfig.json`, related source, and tests. For a new empty workspace, call
`miniapp_init({ projectId, name?, appId? })` once with a lowercase slug. It runs
the pinned official TSX scaffold, applies the JieZi counter/test template, and
stages the native adapter in the current DSH working directory: by default the
working directory itself becomes the project (it must be empty); with
`projectLayout: named-subdirectory` the bridge creates `<cwd>/<projectId>`. No
JieZi checkout, manual CLI lookup, or pre-existing template is required. Never
use it to overwrite an existing/non-empty project.
Continue in the returned actual `projectDir`; subsequent `miniapp_build` calls
can use its `projectId` directly.
If the result reports `signing.signable: false`, the development certificate
cannot sign that `appId`: tell the user before building and prefer the default
`com.jiezi.miniapp.<slug>` id. Use the `read`, `glob`, and `grep` tools for
inspection instead of `cat`/`find`/`grep -rn` through bash, which stay reserved
for real commands such as `nsh test`, `nsh check`, or `shasum`.

Define the initial screen, actions, observable state changes, and requested
persistence/error behavior. Ask only about user-owned choices that inspection
cannot resolve. Read [source-and-capabilities.md](references/source-and-capabilities.md)
before substantial UI work, unfamiliar APIs, storage, or Host integration.

### 2. Implement a small, testable slice

Read [components.md](references/components.md) before selecting components or
writing their props. It maps the `nsh`, `nsh/base`, `nsh/mobile`, and
`jiezi/native` modules and shows current Host component usage. Its bundled
[API snapshot](api/README.md) provides exact declarations and the native adapter
even in an empty workspace; resolve those resources against the skill's own
resource base, never the user's cwd. Once a project exists, reconcile any pinned
version differences with its generated `.nsh/types` declarations. `host.params.components`
determines runtime Host availability. Do not guess an unfamiliar component,
prop, style, event, or host call. Reuse existing navigation,
theme, utilities, and tests. Split substantial screens and data logic into local
modules.

Give every screen, interactive control, and important result/error a stable,
unique `testID`; derive repeated-row ids from stable data ids, not array indices.
Add appropriate roles/accessibility labels and semantic ready/success/error
states. Update Native Shell signals through their APIs rather than assuming
in-place mutations render. Run existing local checks when available, then use
the JieZi build as the delivery gate.

### 3. Build and repair compile errors

```text
miniapp_build({ projectId, projectDir? })
```

A deployable result requires `ok: true` and a `releaseId`. Read reported source
locations and `rawTail`; fix the source and create a new build. Never deploy or
cite the attempted identity of a failed build.

### 4. Deploy the exact release and wait

Use `miniapp_devices` to select the intended paired target. If needed, call
`miniapp_device({ action: "ensure_ready", deviceId })`. Pairing, unlocking,
trusting, and restoring explicitly revoked automation are user actions.

```text
miniapp_deploy({ deviceId, releaseId })
miniapp_status({ opId, wait: true })
```

Read the terminal record. `running` proves only that this exact build launched
without a runtime error during the startup settle window; it does not prove the
requested flow or layout. After a wait timeout, read the same operation again
instead of creating duplicate deployments.

### 5. Verify semantics and visuals

Start with `miniapp_ui`. Reuse its app/instance/snapshot identity and diagnostic
cursor where available. For each key step, call `miniapp_action` with a unique
fresh target and an `expect` (`visibleTestID`, `visibleLabel`, `textContains`,
or `textEquals`). Use `tap`, `type`, or `scroll` as appropriate; re-observe after
scrolling or stale snapshots. Read `state`, `error`, `verification.passed`,
inline diagnostics, Host alerts, and runtime errors even when the envelope has
`ok: true`.

Use `includeFrames: true` for geometry. Use `miniapp_screen` for full-device
pixels including Host chrome/modals, or `miniapp_capture` for its documented
app-view evidence. Actually read returned images before making visual claims.
Verify requested persistence, errors, or appearance modes separately; never
imply untested coverage.

Read [device-verification-and-repair.md](references/device-verification-and-repair.md)
before the first device loop, for exact action habits, or when a result fails.

### 6. Repair from evidence and repeat

For a failed deployment or runtime behavior, call `miniapp_diagnostics` with
its `opId` or `evidenceId`. Keep evidence scoped to that app instance. Fix
compile/load/runtime source errors from actual diagnostics; check Host support
for `host-component`; reduce or correctly declare usage for `refused` rather
than bypassing it. Stop on `automation_disabled`; select an exact host target
for `host_binding_required`.

After every source repair, repeat build → deploy → blocking status → semantic
verification. Do not retry an unchanged refused artifact or silently switch
device/app instance.

## Completion report

State concisely: changed project and behavior; successful release/build and
device if delivered; exact flows/expectations passed; inspected evidence; and
remaining limitations or user action. If delivery or verification did not run,
say so. Never claim “已完成并验证” from source edits, compilation, process
launch, or a startup-only `running` result.
