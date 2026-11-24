# Presentation metadata and the `.jz` package

Read this before changing the app name, summary, description, icon, or
capability purposes, and whenever a build or install fails with a `JZ_*` code.

Every deployable build is one signed `.jz` container: it wraps the signed
`.nshpkg` executable payload with an independently signed outer manifest that
describes what the app library shows (icon, summary, restricted-Markdown
description) and which capabilities the app declares. `nsh.json` stays the
identity and capability authority; `jiezi.json` and `docs/about.md` are ordinary
project source that you author and edit.

## Source files

```text
nsh.json            identity, version/build, capabilities (authority)
jiezi.json          summary + capability purpose text
docs/about.md       the 关于 description (restricted Markdown)
assets/icon.png     optional 1024×1024 sRGB PNG
```

`jiezi.json` is UTF-8 JSON; `schemaVersion` is exactly `1`:

```json
{
  "schemaVersion": 1,
  "summary": "记录每天的小事并跟踪进度。",
  "capabilityPurposes": {
    "clipboard": "仅在点击复制时把文字写入系统剪贴板。"
  }
}
```

Rules:

- `summary` is required, trimmed, 1–120 Unicode scalars, no control characters.
- `capabilityPurposes` values are trimmed, 1–240 scalars, no control characters.
- Every key must be a capability declared in `nsh.json`; a purpose for an
  undeclared capability is refused (`JZ_UNKNOWN_PURPOSE`).
- Every declared **sensitive** capability needs a purpose
  (`JZ_MISSING_PURPOSE`). Sensitive ids: `clipboard`, `picker`, `share`,
  `speech`, `notifications`. `host` needs no purpose.
- A purpose explains behavior; it never widens a declaration or a user grant.

`docs/about.md` is UTF-8 without BOM, LF line endings, at most 64 KiB. Allowed:
headings, paragraphs, hard line breaks, emphasis, inline code, fenced code,
ordered/unordered lists, block quotes, and explicit `[text](https://…)` links.
Not allowed: raw HTML, images, data/file URLs, bare URLs or e-mail addresses,
reference-style links, and remote resources. Bare URLs are refused because the
Host renderer would turn them into tappable links.

`assets/icon.png` is optional: PNG exactly 1024×1024, 8-bit RGB or RGBA, one
`sRGB` chunk, not animated, at most 2 MiB, no pre-applied rounded corners. A
missing icon is valid and the Host draws its default mini-app icon.

`miniapp({ action: "init" })` scaffolds `jiezi.json` and `docs/about.md`, so edit
them like source files. `miniapp({ action: "build" })` writes minimal ones only
for a pre-`.jz` project that has no `jiezi.json` at all, and reports
`presentationCreated` and `synthesizedPurposes`. It never overwrites an authored
file; an authored file that omits a required purpose is a build error, not a
silent fallback.

## Capability declarations

`nsh.json` keeps the Native Shell declaration shapes:

```json
"capabilities": {
  "clipboard": true,
  "openUrl": { "schemes": ["https"] },
  "host": ["storage.file.*", "storage.sqlite.*"]
}
```

A key declares a capability when its value is not `false`; `"host": true` means
all host functions. The outer manifest mirrors this declaration for display and
purpose validation only — it never grants a capability, and NSH/the Host remain
the enforcement authority.

## Identity and size rules

- app id: reverse-DNS, lowercase (`com.jiezi.miniapp.<slug>` is signable by the
  development certificate).
- name: 1–120 Unicode scalars; version: 1–32 scalars; both without control
  characters. build: positive integer, monotonically increasing per app id.
- `minRuntime`: `MAJOR.MINOR.PATCH` from the pinned Native Shell; NSH remains the
  runtime-compatibility enforcer.

## What a successful build returns

Besides `releaseId`, `build`, `artifactPath`, and `sha256`, a signed `.jz` build
returns `format`, `packagePath`, `packageSha256`, `manifestSha256`,
`payloadSha256`, `packageByteSize`, `summary`, `iconSha256`,
`descriptionSha256`, `capabilities`, `purposes`, and `rootKeyId`. Deploy and
install verify the outer signature and every listed hash before trusting that
metadata, so a successful local build is not proof that the device will accept
the package.

## Refusal codes and their fixes

Build errors carry a stable `JZ_*` code in `errors[].message`/`rawTail`; an
install refusal returns the same code in its status/evidence.

| Code | Meaning | Fix |
|---|---|---|
| `JZ_BAD_MANIFEST` | schema, type, identity, path, or digest rule failed | correct `jiezi.json`/`nsh.json`, rebuild |
| `JZ_MISSING_PURPOSE` | declared sensitive capability has no purpose | add purpose text |
| `JZ_UNKNOWN_PURPOSE` | purpose names an undeclared capability | fix the key or drop it |
| `JZ_BAD_DESCRIPTION` | `docs/about.md` breaks the Markdown subset | remove HTML/images/bare URLs/reference links |
| `JZ_BAD_ICON` | icon is not 1024² sRGB RGB/RGBA PNG | re-export the icon |
| `JZ_LIMIT_EXCEEDED` | summary/description/icon/package bound exceeded | shorten text or replace the icon |
| `JZ_PAYLOAD_MISMATCH` | NSH identity differs from the outer manifest | fix the inconsistent metadata and rebuild; never hand-edit the package |
| `JZ_BUILD_CONFLICT` | same app+build is installed with different bytes | increase build and rebuild |
| `JZ_UNTRUSTED` | untrusted root, certificate, or revoked signer/package | stop; report bridge/Host trust state; do not retry unchanged |
| `JZ_BAD_SIGNATURE`, `JZ_HASH_MISMATCH` | signature or integrity failure | stop; rebuild; never patch or retry the same artifact |
| `JZ_DEVELOPMENT_IMPORT` | development-signed package offered to file import | deliver through the paired `miniapp({ action: "deploy" })` route instead |
| `JZ_UNSUPPORTED_FORMAT`, `JZ_CRITICAL_FIELD` | newer/unknown format fields | update the Host/toolchain; never strip fields to force acceptance |

A refusal is never a warning. Fix the named source and create a new build; do
not bypass the rule, edit the `.jz`, or redeploy an unchanged refused artifact.
