# 芥子开发模式 · dsh-jiezi

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的小程序开发插件：给 Agent 一套真正能用的
「初始化 → 编写 → 构建 → 签名 → 真机验证 → 修」闭环，外加一个负责初始化、配对和交付记录的侧栏面板。

- **一个 Agent 预设**：`芥子开发模式`（官方标准 Agent 能力 + 芥子工具，不是封闭的小程序工具集）。
- **十四个 `miniapp_*` 工具**：初始化、构建、部署、重载、状态、环境诊断、界面树、语义操作、截图、录屏、诊断、设备与自动化。
- **一个自带 skill**：`jiezi-miniapp`，讲清 Native Shell TSX、能力声明、真机验证与按诊断修复。
- **一个侧栏面板**：显示桥接状态、配对二维码、设备、最近交付与最近自动化。

## 安装

要求 DeepSeek Harness `0.2.2-rc.1` 及以上（`0.2.x`），macOS arm64 可直接使用；其他平台需要自备 Native Shell 工具链。

**方式一：插件索引（推荐）。** 在 DSH 的「插件 → 发现」里点「添加索引源」，填入：

```
https://raw.githubusercontent.com/FengWuFei/dsh-jiezi/main/index.json
```

GitHub 直连不畅时换成 jsDelivr 镜像（可能比最新发布晚最多 12 小时）：

```
https://cdn.jsdelivr.net/gh/FengWuFei/dsh-jiezi@main/index.json
```

列表里会出现「芥子开发模式」，点安装即可 —— 装的就是 npm 上的 `dsh-jiezi`，索引只是省掉手输包名。
看不到「发现」时，先在「设置 → 实验性插件」里启用插件索引。

**方式二：直接装 npm 包。** 在「插件」页添加插件处输入包名 `dsh-jiezi`，或在终端：

```sh
dsh plugin --profile desktop add dsh-jiezi
dsh plugin --profile web add dsh-jiezi
```

装好后按 DSH 的提示重启（替换已安装插件需要重启才能加载新的 Host 代码）。

离线安装：到 [Releases](https://github.com/FengWuFei/dsh-jiezi/releases/latest) 下载
`dsh-jiezi-<版本>.tgz`，添加插件时填 `file:/绝对路径/dsh-jiezi-<版本>.tgz`。

## 更新

插件从 npm 安装后，DSH 的「插件」页会比较 npm 上的新版本：有更新时列表顶部显示「N 个插件可更新」，
点进插件可以看到版本列表并一键升级，DSH 会自己下载、安装并提示重启 —— 不需要手动改任何文件。

**升级不会清空配对。** 插件和随包桥接可以替换、重启，但配对状态始终沿用 `~/.jiezi`（或配置的
`stateDir`），不会跟随 npm 包目录一起删除。升级后面板会从已有设备记录恢复「已配对」，iPhone 使用
原凭据自动重连；不需要重新初始化，也不需要重新扫码。只有主动解除配对或手动删除桥接状态后，才需要
重新配对。

版本遵循 [SemVer](https://semver.org/lang/zh-CN/)：补丁号修缺陷，次版本号加能力，主版本号做不兼容变更。
每个版本的变更见 [CHANGELOG.md](CHANGELOG.md)，每个版本也都在 GitHub Releases 里附了可直接离线安装的 tgz。

## 第一次使用

1. 装好重启后，侧栏出现「芥子」。打开面板，点「初始化开发环境」—— 它会在 `~/.jiezi` 创建开发密钥、
   TLS 配置和桥接状态，只在你点击后执行，激活插件本身不会创建任何信任材料。
2. 点面板里的配对二维码，用装了芥子宿主 App 的 iPhone 扫描，完成一次配对。二维码会显示剩余时间，
   过期后自动换一张；「检测环境」会一次检查桥接、nsh、宿主版本与自动化状态。
3. 新建一个空目录作为会话工作目录，选「芥子开发模式」预设开始对话。对 Agent 说「用 miniapp_init 初始化一个
   叫 hello 的小程序」，之后 `miniapp_build` → `miniapp_deploy` → `miniapp_ui` / `miniapp_action` 验证。
   环境不确定时先让 Agent 调 `miniapp_doctor`；遇到宿主弹窗用 `miniapp_reload`，不要重复部署同一 release。

`miniapp_init` 默认把**会话工作目录本身**当作项目根（目录必须为空）；一个目录想放多个小程序时，把
`jiezi-tools` 行的配置改成 `projectLayout: named-subdirectory`，它会建 `<工作目录>/<projectId>`。

## 工具

| 工具 | 作用 |
|---|---|
| `miniapp_init` | 从空目录初始化 Native Shell 项目，并预检签名证书覆盖范围 |
| `miniapp_build` | 构建并签名，返回不可变 release（含 sha256） |
| `miniapp_deploy` | 把已签名 release 安装到配对设备；`force: true` 强制重新安装 |
| `miniapp_reload` | 用新操作重新安装并启动当前 release，清掉卡住的实例或宿主弹窗 |
| `miniapp_status` | 查看当前安装、运行时、宿主版本与桥接状态 |
| `miniapp_doctor` | 一次检查桥接身份、nsh、宿主版本、配对与自动化；`fix: true` 只做安全修复 |
| `miniapp_ui` | 读取语义界面树（testID、标签、值、层级） |
| `miniapp_action` | 点击、输入、滚动、断言（失败按数据返回，不会假装成功） |
| `miniapp_capture` / `miniapp_screen` | 截图与录屏 |
| `miniapp_diagnostics` | 取设备侧诊断事件 |
| `miniapp_device` / `miniapp_devices` | 统一设备 schema；列出目标、启动宿主（`launch_host`）或恢复就绪 |
| `miniapp_open` | 重启宿主后直接打开已安装的小程序 |

## 配置

两行插件都接受 `{ socketPath, stateDir, bridgeCliPath, autoStart, timeoutMs }`；`jiezi-tools` 另接受
`projectLayout`。默认值：`socketPath` 为 `$JIEZI_BRIDGE_SOCKET` 或 `~/.jiezi/bridge.sock`，`stateDir` 取它的父目录，
`bridgeCliPath` 依次找 `$JIEZI_BRIDGE_CLI`、包内 `lib/bridge/cli.js`、仓库里的 `vendor/bridge/src/cli.js`。

## 环境要求与边界

- **DSH**：`>=0.2.2-rc.1 <0.3.0`（写进 `engines.dsh`，不满足时插件管理器会拒绝安装）。
- **Native Shell 工具链**：macOS arm64 由可选依赖 `jiezi-nsh-darwin-arm64` 提供；其他平台需自己安装 `nsh`
  并通过 `NSH_TOOLCHAIN` 或 `PATH` 暴露。没有 `nsh` 时初始化/构建会失败，诊断里会说明。
- **设备**：部署、截图、语义验证需要装了芥子宿主 App 的模拟器或已配对 iPhone；纯构建签名不需要设备。
  宿主 `0.1.x` 仍可能弹旧版冻结快照提示；插件会在设备/部署/诊断里标出版本与最低要求，`miniapp_reload`
  可换一个新实例，但根治需要更新宿主 App。
- **不包含**：芥子 iOS App、生产签名证书与 Linux 构建服务。插件只负责开发态的构建、调试与交付。
- 插件不会读取或转存模型供应商凭据；桥接子进程只继承 PATH、HOME、TMPDIR、`NSH*`、`DEVELOPER_DIR` 等最小环境。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → lib/*.js，并把 vendor/bridge 复制进 lib/bridge
npm test            # build + node --test test/*.test.js
npm run test:bridge # 桥接自身的测试
```

`vendor/bridge/` 是芥子桥接的随包快照（版本写在 `vendor/bridge/package.json`，插件按它做精确版本锁）。
它由主仓库同步而来，不在这里单独开发：

```sh
node scripts/sync-bridge.mjs --from /path/to/JieZi/companion/bridge
```

发布流程：改版本号（`npm version patch|minor|major`）→ 推送提交与 tag。tag 触发
[Release 工作流](.github/workflows/release.yml)：跑测试、发布到 npm、生成/更新 `index.json` 并提交回来、
把 tgz 挂到 GitHub Release。仓库里不存 npm 令牌 —— 发布靠 npm 的 trusted publishing（GitHub OIDC），
在 npm 的包设置里把本仓库的 `release.yml` 登记为可信发布者即可。

`jiezi-nsh-darwin-arm64` 是单独发布的工具链包，源码见 `packages/nsh-darwin-arm64/`，产物由
`scripts/pack-nsh.mjs` 从本机 `NSH_TOOLCHAIN` 打出，二进制不进 git。

## 数据与卸载

桥接状态、开发密钥、项目与产物都在 `~/.jiezi`（或配置的 `stateDir`）里。卸载插件不会删除这些数据；
需要清理时手动删除该目录即可。

## 许可证

[MIT](LICENSE)。随包的可选工具链包 `jiezi-nsh-darwin-arm64` 附带
[Native Shell](https://github.com/longbridge/nsh) 的 Apache-2.0 许可证。
