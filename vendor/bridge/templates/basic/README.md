# {{PROJECT_NAME}}

A JieZi mini-app initialized as `{{PROJECT_ID}}` with app id `{{APP_ID}}`.

- `App.tsx`: a small reactive counter with stable semantic testIDs.
- `App.test.tsx`: the headless Native Shell behavior check.
- `nsh.json`: app identity and default-deny capability declarations.
- `node_modules/jiezi/native`: the plugin-provided Host adapter for later
  `NativeUITableView`/`NativeUICollectionView` work; no npm install is needed.

Ask the JieZi development Agent for the next feature. It should edit this
project, run its checks, then use `miniapp_build`, `miniapp_deploy`, and
`miniapp_status` before semantic device verification.
