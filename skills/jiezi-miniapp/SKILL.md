---
name: jiezi-miniapp
description: Develop, modify, build, deploy, and debug JieZi Native Shell mini-apps using TSX, the miniapp action tool, and the skill-gated miniapp_ui/miniapp_action tools. Use for 创建/开发/修改/调试/构建/部署/验证芥子小程序, screens, reactive state, storage, native components, and compile/runtime/device failures in 芥子开发模式. Not for changing the iOS Host, bridge, signing, or adding unsupported native capabilities.
---

# JieZi mini-app development

Deliver a working Native Shell app and verify the user's flow on the intended
paired device. Source edits or compilation alone are not delivery. Edit source
with the normal tools; use `miniapp` for project, build, delivery, device,
doctor and diagnostics. Loading this skill admits `miniapp_ui` and
`miniapp_action`; [tool-reference.md](references/tool-reference.md) lists the actions, key
parameters, results and error codes.

## Boundaries

- Stay inside the project: no npm dependencies, native/DOM code, second
  toolchain, bridge/profile/signing edits, generated `.nsh` edits, or files
  outside the project; never seek or embed credentials.
- Use only capabilities the installed Host supports. Reviewed `jiezi/native`
  components need no per-app grant; a new native capability needs a Host
  release and explicit approval.
- Presentation is source: `jiezi.json` and `docs/about.md` ship in the signed
  `.jz`; fix `JZ_*` refusals at the source, never bypass them.
- Keep the existing app id and working code; never bypass permission, pairing,
  or signature refusals.

## Procedure

### 1. Inspect and define one acceptance flow

When a project exists, read `nsh.json`, `jiezi.json`, `docs/about.md`, its
entry TSX (normally `App.tsx`), `tsconfig.json`, related source, and tests. For a new empty workspace, call
`miniapp({ action: "init", projectId, name?, appId? })` once with a lowercase slug. It runs
the pinned TSX scaffold, adds a counter/test template, stages the native
adapter, and makes the empty working directory the project by default
(`projectLayout: named-subdirectory` creates `<cwd>/<projectId>`). No JieZi checkout is required. Never use it to overwrite an existing project.
Continue in the returned actual `projectDir`; subsequent `miniapp({ action: "build" })` calls
can use its `projectId` directly.
If the result reports `signing.signable: false`, the development certificate
cannot sign that `appId`: tell the user before building and prefer the default
`com.jiezi.miniapp.<slug>` id.

Define the initial screen, actions, observable state changes, and requested
persistence/error behavior. Ask only about user-owned choices that inspection
cannot resolve. If the bridge, toolchain, Host version, or pairing state is
uncertain, call `miniapp({ action: "doctor" })` once and follow its `ready`/`blockers`/
`nextActions` instead of guessing. Read
[source-and-capabilities.md](references/source-and-capabilities.md)
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
Add roles/accessibility labels and ready/success/error states. Update signals
through their APIs, not in-place mutation assumptions. Run local checks, then
the JieZi build as the gate.

### 3. Build and repair compile errors

```text
miniapp({ action: "build", projectId, projectDir? })
```

A deployable result requires `ok: true` and a `releaseId`. Each build packs a
signed `.jz` around the `.nshpkg`, so the presentation rules for `jiezi.json`,
`docs/about.md`, and the optional icon can fail it with a stable `JZ_*` code.
Read reported source locations and `rawTail`; fix the source and rebuild. Never
deploy or cite the attempted identity of a failed build. Read
[presentation-and-package.md](references/presentation-and-package.md) before
changing the name, summary, description, icon, or purposes, or when a `JZ_*`
code appears.

### 4. Deploy the exact release and wait

Use `miniapp({ action: "device", deviceAction: "list" })` to pick the paired
target; `jieziPaired`, `coreDevicePaired`, and `hostRunning` are separate facts.
`miniapp({ action: "device", deviceAction: "ensure_ready", deviceId })` recovers
what it can; pairing, unlocking, trusting, and restoring revoked automation are
user actions.

```text
miniapp({ action: "deploy", deviceId, releaseId })
miniapp({ action: "status", opId, wait: true })
```

A `deduplicated`/`reinstalled: false` deploy did not start a new install. For a
stuck instance or a blocking Host alert, use
`miniapp({ action: "reload", deviceId })` (or `force: true`) and wait on its new
opId. `miniapp({ action: "open" })` never restarts a running instance.

Read the terminal record. `running` proves only that this exact build launched
without a runtime error during the startup settle window; it does not prove the
requested flow or layout. After a wait timeout, read the same operation again
instead of creating duplicate deployments.

### 5. Verify semantics and visuals

Start with `miniapp_ui` (default `mode: "outline"`). Reuse its app/instance/snapshot identity and diagnostic
cursor where available. For each key step, call `miniapp_action` with a unique
fresh target and an `expect` (`visibleTestID`, `visibleLabel`, `textContains`,
`textEquals`, or `checks`). Hidden
nodes are omitted by default; do not set `includeHidden` unless diagnosing
recycled rows. Use `tap`, `type`, or `scroll` as appropriate; re-observe after
scrolling or stale snapshots. Read `state`, `error`, `verification.passed`,
`snapshotIssues`, inline diagnostics, `hostAlert`/`host`, and runtime errors even
when the envelope has `ok: true`.

Use `includeFrames: true` for geometry; `miniapp_ui({ mode: "screen" })` for
full-device pixels, `miniapp_ui({ mode: "capture" })` for app-view evidence. Read
images before visual claims; verify persistence/errors/appearance separately.

Read [device-verification-and-repair.md](references/device-verification-and-repair.md)
for exact action habits and failure routing.

### 6. Repair from evidence and repeat

For a failed deployment or runtime behavior, call
`miniapp({ action: "diagnostics", opId })` (or `evidenceId`). Keep evidence scoped to that app instance. Fix
compile/load/runtime source errors from actual diagnostics; check Host support
for `host-component`; reduce or correctly declare usage for `refused` rather
than bypassing it. `HOST_ALERT_BLOCKING` is a Host-layer alert: do not rebuild
the same release to dismiss it; update the Host or clear the alert on the phone.
Stop on `automation_disabled`; select an exact host target for
`host_binding_required`.

After every source repair, repeat build → deploy → blocking status → semantic
verification. Do not retry an unchanged refused artifact or silently switch
device/app instance.

## Completion report

State concisely: changed project and behavior; release/build and device when
delivered; expectations that passed; inspected evidence; remaining limitations.
If delivery or verification did not run, say so. Never claim “已完成并验证” from
source edits, compilation, launch, or a startup-only `running` result.
