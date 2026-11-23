# Device verification and repair

Use this reference for the first build/deploy loop, semantic actions, visual
evidence, or any failure. The tool result is evidence only for the release,
device, operation, and app instance it names.

## Build → deploy → terminal status

1. If no project exists, create it once with
   `miniapp_init({ projectId, name?, appId? })`; never reinitialize over existing
   work. Then call `miniapp_build({ projectId, projectDir? })`. Continue only with
   `ok: true` and a returned `releaseId`; compile failures have no deployable
   release even if an attempted build number appears.
2. Call `miniapp_devices` and choose the intended paired `deviceId`. If the
   bridge/Host is offline, `miniapp_device({ action: "ensure_ready", deviceId })`
   performs supported recovery and verifies actual developer automation.
   `miniapp_device({ action: "list" })` shows targets/bindings when selection
   is ambiguous.
3. Call `miniapp_deploy({ deviceId, releaseId })`, then immediately
   `miniapp_status({ opId, wait: true })`. This blocks for the terminal record;
   do not end the turn or start a polling loop.
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
```

Prefer a stable `testID`. Otherwise use a fresh alias/path or label+role.
For repeated content, disambiguate the source with stable data-based testIDs
rather than guessing. A text-field tap or its testID container can focus it;
`replace` defaults to true. Read the fresh focused non-secure field value when
available. Scroll the nearest container or a descendant, then re-observe.

An action request can return data while the action or expectation failed.
Inspect `state`, `error`, `verification.passed`, inline diagnostics, Host alert,
and runtime error. A Host alert blocks the page behind it; do not treat it as
mini-app content. Carry the returned diagnostic cursor forward to avoid
re-reading old events. Custom gestures are not synthesized.

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
