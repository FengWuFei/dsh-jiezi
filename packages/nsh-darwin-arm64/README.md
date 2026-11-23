# jiezi-nsh-darwin-arm64

macOS arm64 版 Native Shell（`nsh`）命令行，作为 [`dsh-jiezi`](https://github.com/FengWuFei/dsh-jiezi)
的可选依赖分发。只包含 `bin/nsh`：桥接的 `publish`、`keygen`、`certify` 不需要 294 MB 的
iOS/macOS 宿主运行时和组件目录。

- 上游：[longbridge/nsh](https://github.com/longbridge/nsh)
- 许可证：Apache-2.0，见 `LICENSE-APACHE`
- 固定版本：`nsh 0.6.0`
- 来源：由维护者用 `scripts/pack-nsh.mjs` 从本机固定工具链打出；二进制不进 git。

`nsh` 是构建工具，不是 Node 模块：它由 `jiezi-bridge` 拉起，永远不会被 import 进 DSH 进程。
插件在 `PATH`、`NSH_TOOLCHAIN`、`~/.jiezi/tooling/nsh/bin/nsh` 和本包之间按顺序查找 `nsh`。
