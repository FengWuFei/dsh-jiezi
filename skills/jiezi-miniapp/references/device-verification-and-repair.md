# Device verification and repair

Use this reference for the delivery loop, semantic actions, visual evidence, or
any failure. A result is evidence only for the release, device, operation and
app instance it names.

## Environment check

Call `miniapp({ action: "doctor" })` once when the bridge, nsh, Host version,
pairing, or automation state is uncertain. Read `ready`, `blockers`, and
`nextActions` instead of guessing. `fix: true` rewrites a stale configured nsh
path and restarts a stale bridge; it never initializes trust, pairs, launches
the Host, or enables automation.

`miniapp({ action: "device", deviceAction: "list" })` replaces the former
`miniapp_devices`/`miniapp_device list` pair. `jieziPaired`, `coreDevicePaired`,
and `hostRunning` are three different facts; `hostVersion` plus
`hostCompatibility` says whether the Host is old enough to show the legacy
freeze-snapshot alert. When no `deviceId` is paired yet,
`miniapp({ action: "device", deviceAction: "launch_host", hostDeviceId })` starts
the installed Host before the QR pairing step.

## Build → deploy → terminal status

1. If no project exists, create it once with
   `miniapp({ action: "init", projectId, name?, appId? })`; never reinitialize
   over existing work. Then `miniapp({ action: "build", projectId })`; continue
   only with `ok: true` and a `releaseId`. A compile failure has no deployable
   release even if a build number appears.
2. Call `miniapp({ action: "device", deviceAction: "list" })` and choose the
   intended paired `deviceId`. If the bridge/Host is offline,
   `miniapp({ action: "device", deviceAction: "ensure_ready", deviceId })`
   performs supported recovery and verifies actual developer automation.
   `launch_host` starts the Host before pairing; `list` shows targets/bindings
   when selection is ambiguous.
3. Call `miniapp({ action: "deploy", deviceId, releaseId })`, then immediately
   `miniapp({ action: "status", opId, wait: true })`. This blocks for the
   terminal record; do not end the turn or start a polling loop.
   A `deduplicated: true` / `reinstalled: false` result did not start a new
   install. If the old instance is stuck or a Host alert covers it, call
   `miniapp({ action: "reload", deviceId })` (or deploy with `force: true`) and
   then wait on the new opId. `miniapp({ action: "open", deviceId, appId })` only
   opens an installed app when none is running; it never restarts a live
   instance.
4. `running` means the new instance of that exact build started and no runtime
   error appeared during its startup settle window. It is not interaction or
   visual acceptance. `failed` requires reading its layer and evidence.
5. A wait timeout leaves the operation alive. Read the same `opId` again; a
   later terminal update may still reach the Agent. Avoid duplicate deploys.

Pairing, unlock/trust, a missing Host or revoked automation can require user
action. Never request pairing secrets or try another channel to override it.

## Semantic observe → act → verify

Call `miniapp_ui` (`mode: "outline"`, the default) for a fresh bounded outline.
It returns semantic selectors, app/instance/snapshot identity, and a diagnostic
cursor. Modal/dialog nodes are included while open; hidden background controls
are not valid targets.

Use `miniapp_action` with one unique selector and an expected result:

```text
tap:    { deviceId, action: "tap", target: { testID: "save" },
          expect: { visibleTestID: "status-saved" }, appId?, instanceId?,
          snapshotId?, diagnosticCursor? }
type:   { deviceId, action: "type", target: { testID: "field-title" },
          text: "Example", replace: true, expect: { textEquals: "Example" } }
scroll: { deviceId, action: "scroll", target: { testID: "list" },
          direction: "up", amount: 0.8 }
checks: { deviceId, action: "tap", target: { testID: "task-row-1" },
          expect: { checks: [
            { testID: "task-progress", textContains: "1 / 3" },
            { testID: "task-hint", textEquals: "已保存" },
          ] } }
```

`expect.checks` is ANDed and scopes each text assertion to its testID, so one
action can prove both progress and a hint. `includeHidden: true` is only for
diagnosing recycled/hidden nodes; hidden duplicates of a visible testID are
already removed and normal outlines omit hidden nodes.

Prefer a stable `testID`. Otherwise use a fresh alias/path or label+role.
For repeated content, disambiguate the source with stable data-based testIDs
rather than guessing. A text-field tap or its testID container can focus it;
`replace` defaults to true. Read the fresh focused non-secure field value when
available. Scroll the nearest container or a descendant, then re-observe.

An action can return data while the action or expectation failed. Inspect
`state`, `error`, `verification.passed`, `snapshotIssues`, diagnostics,
`hostAlert`/`host` and `runtimeError`. `HOST_ALERT_BLOCKING`
(`error.category: "host"`) is the Host layer, not app content: do not rebuild or
redeploy for it; ask for a Host update when below `host.minimumVersion`,
otherwise handle it on the phone. Carry the diagnostic cursor forward. Custom gestures and arbitrary key presses are not synthesized; focus
state is visible on the snapshot node (`focused`).

Use `includeFrames: true` when frame/screen geometry matters.
`miniapp_ui({ mode: "screen" })` returns a full-screen PNG path through the DSH
computer, including Host chrome and modals.
`miniapp_ui({ mode: "capture" })` returns app-view tree/screenshot evidence
within its limits and may return a `requestId` to re-read. Open the image before
claiming layout, clipping, contrast, or visual success. After a Host
restart, `miniapp({ action: "open", deviceId, appId })` opens an installed app
without redeploying; Host readiness and mini-app selection are separate steps.

## Diagnostics and failure routing

Call `miniapp({ action: "diagnostics", opId })` (or `evidenceId`) with the failed
operation. Read the bounded summary before the report path. Do not attribute
another build's earlier error to the current instance.

| Layer/result | Correct response |
|---|---|
| `compile` | Fix reported TSX/source/configuration and rebuild |
| `load` | Inspect entry, imports, assets, loading and runtime compatibility evidence |
| `runtime` | Read newest scoped/action-time errors; repair source and redeploy |
| `host-component` | Check actual Host/wire support; use a supported fallback or stop for a Host release |
| `HOST_ALERT_BLOCKING` | Host layer, not app source: update the Host or dismiss the alert; do not redeploy the unchanged mini-app |
| `refused` | Inspect capability/signature/permission denial; reduce or correctly declare use |
| `JZ_BUILD_CONFLICT` | Same app+build is installed with different bytes: raise the build number, rebuild, redeploy; never retry unchanged |
| `JZ_UNTRUSTED`, `JZ_DEVELOPMENT_IMPORT` | Trust/route refusal: report trust state; deliver development-signed releases only through paired deploy; no bypass |
| `automation_disabled` | Stop; only the user can explicitly restore automation |
| `host_binding_required` | List targets and supply the exact `hostDeviceId`; never guess |
| stale/ambiguous UI | Re-observe and improve stable selectors/observable state |
| timeout | Check operation/readiness evidence; do not relabel it failure or success |

Build-side `JZ_*` codes (`JZ_BAD_MANIFEST`, `JZ_MISSING_PURPOSE`,
`JZ_BAD_DESCRIPTION`, `JZ_BAD_ICON`, …) are source defects: fix them per
[presentation-and-package.md](presentation-and-package.md) and rebuild. A
refusal is never a warning.

After a source fix, rerun the loop with the new release. Never retry an
unchanged refused artifact, silently change the device, or combine evidence from
different instances.

## Honest completion

A credible report names the source change, release/build and device when known,
and the exact expectations that passed. Distinguish local checks, compilation,
startup `running`, semantic verification, and visual inspection. List unrun
persistence/appearance/error checks and blockers explicitly. If no device was
available, say the app was implemented or built, not that it was device-verified.
