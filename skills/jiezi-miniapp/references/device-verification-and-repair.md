# Device verification and repair

Use this reference for the first build/deploy loop, semantic actions, visual
evidence, or any failure. The tool result is evidence only for the release,
device, operation, and app instance it names.

## Environment check

Call `miniapp_doctor` once when the bridge, nsh, Host version, pairing, or
automation state is uncertain. Read `ready`, `blockers`, and `nextActions`
instead of guessing. `fix: true` rewrites a stale configured nsh path and
restarts a stale bridge; it never initializes trust, pairs, launches the Host,
or enables automation.

`miniapp_devices` and `miniapp_device({ action: "list" })` share one schema.
`jieziPaired`, `coreDevicePaired`, and `hostRunning` are three different facts;
`hostVersion` plus `hostCompatibility` says whether the Host is old enough to
show the removed freeze-snapshot alert. When no `deviceId` is paired yet,
`miniapp_device({ action: "launch_host", hostDeviceId })` starts the installed
Host before the QR pairing step.

## Build → deploy → terminal status

1. If no project exists, create it once with
   `miniapp_init({ projectId, name?, appId? })`; never reinitialize over existing
   work. Then call `miniapp_build({ projectId, projectDir? })`. Continue only with
   `ok: true` and a returned `releaseId`; compile failures have no deployable
   release even if an attempted build number appears.
2. Call `miniapp_devices` and choose the intended paired `deviceId`. If the
   bridge/Host is offline, `miniapp_device({ action: "ensure_ready", deviceId })`
   performs supported recovery and verifies actual developer automation.
   `launch_host` starts the Host before pairing; `list` shows targets/bindings
   when selection is ambiguous.
3. Call `miniapp_deploy({ deviceId, releaseId })`, then immediately
   `miniapp_status({ opId, wait: true })`. This blocks for the terminal record;
   do not end the turn or start a polling loop.
   A `deduplicated: true` / `reinstalled: false` result did not start a new
   install. If the old instance is stuck or a Host alert covers it, call
   `miniapp_reload({ deviceId })` (or deploy with `force: true`) and then wait
   on the new opId. `miniapp_open` only opens an installed app when none is
   running; it never restarts a live instance.
4. `running` means the new instance of that exact build started and no runtime
   error appeared during its startup settle window. It is not interaction or
   visual acceptance. `failed` requires reading its layer and evidence.
5. A wait timeout leaves the operation alive. Read the same `opId` again; a
   later terminal update may still reach the Agent. Avoid duplicate deploys.

Pairing, device unlock/trust, missing Host installation, and explicitly revoked
automation can require user action. Do not request pairing secrets or attempt
another channel to override revocation.

## Semantic observe → act → verify

Call `miniapp_ui` for a fresh bounded outline. It returns semantic selectors,
app/instance/snapshot identity, and a diagnostic cursor. Modal/dialog nodes are
included while open; hidden background controls are not valid targets.

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

An action request can return data while the action or expectation failed.
Inspect `state`, `error`, `verification.passed`, `snapshotIssues`, inline
diagnostics, `hostAlert`, `host`, and `runtimeError`. A Host alert blocks the
page behind it and is not mini-app content: `HOST_ALERT_BLOCKING` with
`error.category: "host"` means the Host App is the failing layer. Do not rebuild
or redeploy the mini-app for it. If the Host version is below
`host.minimumVersion`, ask for a Host update; otherwise handle the alert on the
phone. Carry the returned diagnostic cursor forward to avoid re-reading old
events. Custom gestures and arbitrary key presses are not synthesized; focus
state is visible on the snapshot node (`focused`).

Use `includeFrames: true` when frame/screen geometry matters. `miniapp_screen`
returns a full-screen PNG path through the DSH computer, including Host chrome
and modal layers. `miniapp_capture` returns app-view tree/screenshot evidence
within its limits and may return a `requestId` to re-read. Open the actual image
before claiming layout, clipping, contrast, or visual success. After a Host
restart, `miniapp_open({ deviceId, appId })` opens an installed app without
redeploying; Host readiness and mini-app selection are separate steps.

## Diagnostics and failure routing

Call `miniapp_diagnostics` with the failed operation's `opId` or its
`evidenceId`. Read the bounded summary before the report path. Do not attribute
another build's earlier error to the current instance.

| Layer/result | Correct response |
|---|---|
| `compile` | Fix reported TSX/source/configuration and rebuild |
| `load` | Inspect entry, imports, assets, loading and runtime compatibility evidence |
| `runtime` | Read newest scoped/action-time errors; repair source and redeploy |
| `host-component` | Check actual Host/wire support; use a supported fallback or stop for a Host release |
| `HOST_ALERT_BLOCKING` | Host layer, not app source: update the Host or dismiss the alert; do not redeploy the unchanged mini-app |
| `refused` | Inspect capability/signature/permission denial; reduce or correctly declare use |
| `automation_disabled` | Stop; only the user can explicitly restore automation |
| `host_binding_required` | List targets and supply the exact `hostDeviceId`; never guess |
| stale/ambiguous UI | Re-observe and improve stable selectors/observable state |
| timeout | Check operation/readiness evidence; do not relabel it failure or success |

After a source fix, run the entire loop again with the new release. Never retry
an unchanged refused artifact, silently change the device, or combine evidence
from different instances.

## Honest completion

A credible report names the source change, release/build and device when known,
and the exact expectations that passed. Distinguish local checks, compilation,
startup `running`, semantic verification, and visual inspection. List unrun
persistence/appearance/error checks and blockers explicitly. If no device was
available, say the app was implemented or built, not that it was device-verified.
