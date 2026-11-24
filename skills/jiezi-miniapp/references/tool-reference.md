# Tool reference

Three tools replace the former fourteen `miniapp_*` tools. `miniapp` is always
available; `miniapp_ui` and `miniapp_action` are admitted only after this skill
loads (resume/fork keeps a prior declaration). A skill invoked from the UI
admits them on the next step; if they are still missing after a resume, call
the `skill` tool with `jiezi-miniapp` once. Results keep the previous
envelopes: bounded JSON, stable `JZ_*`/bridge codes and on-disk evidence paths.

## `miniapp` — project, delivery, device and diagnostics

| `action` | Parameters | Result |
| --- | --- | --- |
| `init` | `projectId`, `name?`, `appId?` | project id/dir, template, adapter, `signing { certificate, signable }` |
| `build` | `projectId`, `projectDir?` | `ok`, `releaseId`, build number, artifact/package paths, digests, summary/purposes, or structured compile errors with `JZ_*` codes |
| `deploy` | `deviceId`, `releaseId`, `force?` | `opId`, `state`, `host { version, minimumVersion, compatibility }`, dedupe/reinstall flags; registers this Agent for the terminal wake-up |
| `status` | `opId?`, `deviceId?`, `wait?`, `timeoutMs?` | one operation, or the device's recent operations; `wait: true` requires `opId`, blocks for `running`/`failed` and returns `timedOut` (timeout 1000–600000, default 30000) |
| `reload` | `deviceId`, `releaseId?`, `appId?` | fresh `opId` from a forced reinstall of the active/installed release |
| `open` | `deviceId`, `appId`, `timeoutMs?` | `requestId`, state, instance id, or a bridge/Host failure; never restarts a live instance |
| `device` | `deviceAction: list\|ensure_ready\|launch_host` (default `list`), `deviceId?`, `hostDeviceId?`, `rebind?`, `waitMs?` | paired devices, CoreDevice targets, bindings, Host version/compatibility, readiness or launch result; `ensure_ready` requires `deviceId`, `list` takes no deviceId/hostDeviceId, `waitMs` is 1000–90000 (default 30000) |
| `doctor` | `fix?` | `ready`, `blockers`, `nextActions`; `fix` only rewrites a stale nsh path or restarts a stale bridge |
| `diagnostics` | `opId?` or `evidenceId?` | failure layer, summary, counts, on-disk report path; event bodies and screenshots stay on disk |

`deploy` wakes the Agent that started it when the operation ends. The notice
carries the evidence id and the next action; a blocking `status` suppresses it
so the result arrives exactly once. A timed-out `status` leaves the operation
alive: read the same `opId` again instead of redeploying.

## `miniapp_ui` — read the screen

| `mode` | Purpose | Parameters |
| --- | --- | --- |
| `outline` (default) | bounded semantic outline for `miniapp_action` | `deviceId`, `appId?`, `instanceId?`, `snapshotId?`, `diagnosticCursor?`, `includeFrames?`, `includeHidden?`, `opId?`, `timeoutMs?` |
| `capture` | page tree plus screenshot path | `deviceId`, `waitMs?` (0–15000), `requestId?` |
| `screen` | full device PNG through the Host | `deviceId`, `hostDeviceId?` |

An outline returns aliases, testIDs, labels, roles, paths, app/instance/snapshot
identity and a diagnostic cursor; it exposes no `capabilities` list, so never
treat an outline as a component catalog. A page tree over 12,000 characters
returns `treeTruncated: true` plus `treeChars` and the screenshot path. `screen`
includes the status bar, Host chrome and modal layers, works with no active
mini-app, and returns a local PNG path only (read the file for pixels).

## `miniapp_action` — act and verify

One unique target (`target: { testID | label+role | alias | path }`) with
`action: "tap" | "type" | "scroll"`; optional `appId`, `instanceId`,
`snapshotId`, `diagnosticCursor`, `includeFrames`, `includeHidden`, `opId`
(idempotency) and `timeoutMs` scope the call:

- `type`: `text`, `replace?` (default true); secure values stay redacted.
- `scroll`: `direction?` (default down), `amount?` (0.1–1, default 0.8).
- `expect?`: `visibleTestID`, `visibleLabel`, `textContains`, `textEquals`, or
  `checks` (up to 8 `{ testID|label, textContains?, textEquals?, focused? }`).
  `textContains`/`textEquals` are scoped to the check's testID/label; `focused`
  is evaluated against the whole visible outline.

The result returns the fresh outline, `verification.passed`, `diagnosticCursor`,
action-time diagnostics, `hostAlert`, `host`, `runtimeError` and
`snapshotIssues`. A missing, ambiguous, disabled, stale, non-input or
alert-blocked target is a failure result, not a blind retry.

## Errors

Bridge failures keep their codes (`device_offline`, `target_not_found`,
`target_ambiguous`, `automation_disabled`, `host_binding_required`,
`host_component_unsupported`, `timeout`, …). Build refusals keep `JZ_*` codes
and source locations. `invalid_request` means the arguments were wrong; every
other failure names the failing layer. `HOST_ALERT_BLOCKING` is the Host App
layer: do not rebuild or redeploy for it.
