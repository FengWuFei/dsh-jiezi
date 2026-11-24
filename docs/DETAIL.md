# 芥子开发模式（`dsh-jiezi`）

给 DeepSeek Harness 装上「芥子」小程序开发闭环：一个 Agent 预设、一个 `miniapp` 动作枚举工具、
两个技能加载后才出现的观察工具、一个自带 skill，以及一个侧栏面板。预设是**官方标准 Agent 能力 +
芥子工具**，不是封闭的小程序工具集；构建、签名与安装协议的实现仍在随包的 `jiezi-bridge` 里，
插件只负责调用与监督。

## 装上之后

1. 侧栏出现「芥子」。首次打开面板时点「初始化开发环境」：插件用打包进来的 `lib/bridge/cli.js`
   在 `~/.jiezi` 创建开发密钥、TLS 配置与桥接状态。这一步只在点击后执行，插件激活时不会创建信任材料。
2. 面板显示本地渲染的配对二维码；用装了芥子宿主 App 的 iPhone 扫描，完成一次配对。
3. 新建空目录作为会话工作目录，选「芥子开发模式」预设，让 Agent 用 `miniapp` 的 `init` 动作开始。

面板展示配对等待/成功/过期、在线设备、最近交付和最近的语义自动化；二维码在浏览器本地生成，
不经过任何二维码服务。

## 交付闭环

```text
miniapp(doctor)   → 桥接身份 / nsh / 宿主版本 / 配对 / 自动化一次检查
miniapp(init)     → 新的 TSX 项目 + 计数器测试 + jiezi/native 适配层 + jiezi.json/docs/about.md 表现层文件
miniapp(build)    → 签名 .jz 容器（releaseId + 容器/清单/载荷 sha256，或指向源码行的结构化 JZ_* 错误）
miniapp(deploy)   → opId（pending；重复 release 会去重，force/reload 会新建）
miniapp(reload)   → 同一 release 的新安装/启动操作（卡住实例或宿主弹窗时用）
设备              → downloading / verifying / installing / launching
设备              → 诊断证据 jiezi.diagnostics.v1
设备              → running | failed（带 evidenceId）
Agent             → miniapp(diagnostics) → 改源码 → 再次 miniapp(build)
```

一个常驻的 `miniapp` 工具用 `action` 枚举覆盖项目、交付、设备、环境与诊断；`miniapp_ui` 与
`miniapp_action` 只在 `jiezi-miniapp` 技能加载后出现，普通编码会话不会携带它们的 schema。
能力与原十四个逐动作工具一一对应，映射与参数见
[Skill 工具参考](../skills/jiezi-miniapp/references/tool-reference.md)。

每个 release 都是单个签名 `.jz`：可执行载荷仍是签名的 `.nshpkg`，外层再包一层独立签名的清单，
记录应用库展示所需的图标、摘要、`docs/about.md` 受限 Markdown 说明和能力用途。`jiezi.json` 与
`docs/about.md` 是项目源码，由 `miniapp` 的 `init` 动作生成；构建会校验摘要长度、Markdown 子集、可选图标的
1024×1024/sRGB 规则与敏感能力用途，并以稳定的 `JZ_*` 码报告失败。对没有 `jiezi.json` 的旧项目，
构建只在缺失时补齐最小表现层文件并报告 `presentationCreated`/`synthesizedPurposes`。

`miniapp` 的 `init` 动作用 Host 提供的会话工作目录作为调用根，具体位置由 `jiezi-tools` 行的
`projectLayout` 决定：默认 `working-directory` 直接把工作目录当成项目根（必须是空目录）；
`named-subdirectory` 则建 `<工作目录>/<projectId>`，一个目录可以放多个小程序。桥接配置的
project root 只在没有会话工作目录时兜底。项目因此落在标准 `workspace-write` 沙箱内，
`nsh test` / `nsh check` 不需要额外授权。

初始化结果带 `signing: { certificate, signable }` 与 `warnings`：开发证书只覆盖
`com.jiezi.*`，超出范围的 `appId` 在构建前就会被指出，而不是等到 `nsh publish` 才发现。

`miniapp` 的 `status` 动作传 `wait: true` 时会在工具内等终态；未被收集的终态会以 `jiezi-delivery`
提示交回 Agent，携带操作 id、状态、失败层与 evidenceId，不会伪装成用户输入。

## 配对与自动化

配对载荷是固定的六字段 `{ schema: "jiezi.pairing.v1", sessionId, endpoint, code,
certificateFingerprint, expiresAt }`，由桥接产生、Host 原样返回、面板本地校验并渲染。

语义自动化只在「设备在线 + 开发者模式 + 已确认的前台授权」时可用：

```text
miniapp_ui(outline) → 观察：snapshotId + 紧凑界面树（testID/标签/角色/别名/路径）
                 includeFrames 可带 frame=x,y WxH 与 screen=WxH
                 弹层/弹窗节点包含在内，被它遮住的页面不列出
miniapp_action → 点击唯一可见目标、向文本框输入、或滚动最近的滚动视图
               → 返回新的界面树（聚焦中的非安全输入框带 value/focused），或桥接自己的
                 failed/timeout/unsupported 结果
miniapp_ui(screen) → 经 simctl/devicectl 截全屏 PNG（状态栏、弹层、宿主外壳）
miniapp(open)  → 宿主重启后直接打开已安装的小程序，不重新下载产物
```

自动化结果始终按数据返回，不会被包装成「成功」。Agent 必须先读状态与错误再声称操作生效；
宿主弹窗会以 `HOST_ALERT_BLOCKING` 阻止点击/输入，它不属于小程序内容，也不会被列为可点节点。
插件把它与 `runtimeError` 分开，保留 appId/instanceId 和宿主版本；当宿主低于最低版本时，错误信息
要求更新宿主或清除弹窗，而不是让 Agent 重复部署同一 release。

`miniapp` 的 `device` 动作（`deviceAction: "list"`）使用一套设备 schema：`jieziPaired`（桥接配对）、
`coreDevicePaired`（CoreDevice/Xcode 配对）、`hostRunning`（宿主开发者模式连接）分开表达，
并带 `hostVersion` / `hostCompatibility` / `boundHostDeviceId` / `nextAction`。`launch_host`
不需要先有 `deviceId`：按 `hostDeviceId`、已有绑定或唯一可见目标拉起宿主。`ensure_ready`
启动已初始化的桥接、做一次无令牌的 `dev_* → UDID` 绑定、用固定 argv 拉起已安装宿主，
并等待真实的「开发者模式 + 自动化」就绪。多个可疑目标时返回 `host_binding_required`；
`automation_disabled` 是用户明确撤销，不会被覆盖。设备锁定、宿主缺失、iOS 信任被撤销、
设备离线都会如实报错。

## 要求

- 已初始化的桥接状态目录（默认 `~/.jiezi`）：Host 按需启动 `serve`，从不自动 `init`。
- 已配对设备（部署、截图、语义验证需要）；纯构建签名不需要设备。
- 构建需要固定的 Native Shell `nsh`：macOS arm64 由可选依赖 `jiezi-nsh-darwin-arm64` 提供，
  其他平台通过 `NSH_TOOLCHAIN` 或 `PATH` 提供；Host 侧生命周期恢复需要 Xcode 的
  `devicectl` / `simctl`（仅 macOS）。
- 本包不包含芥子 iOS App，也不包含生产签名证书与 Linux 构建服务。

## 配置

两行插件都接受 `{ socketPath, stateDir, bridgeCliPath, autoStart, timeoutMs }`，`jiezi-tools`
另接受 `projectLayout` 与 `activationSkills`（默认 `['jiezi-miniapp']`，技能加载后放行观察工具；显式配置必须是非空
且合法的 skill 名列表，否则插件加载失败）。`socketPath` 默认 `$JIEZI_BRIDGE_SOCKET` 或 `~/.jiezi/bridge.sock`；
`stateDir` 默认取它的父目录；`bridgeCliPath` 依次取 `$JIEZI_BRIDGE_CLI`、包内
`lib/bridge/cli.js`、仓库里的 `vendor/bridge/src/cli.js`；`timeoutMs` 默认 30000。
随包 patch 在两行上开启 `autoStart`，让它们共用同一个被监督的 operations 实例。

supervisor 不只比较版本：它用包根目录、模块内容哈希与启动时间识别「同版本但旧代码」的桥接。
自己拉起的进程、报告安装根等于本包的进程、或命令行精确指向本 CLI + 状态目录的进程会被安全重启；
无法证明归属时返回 `bridge_identity_mismatch`，不会误杀其他 profile 的桥接。启动/每次构建还会重新解析
失灵的 `nshPath`，并在 `doctor --fix` 中只回写这一项配置。

## 限制（P0）

这是开发态的交付/生命周期通路：不实现 APNs/后台唤醒、自动打包安装 IPA、设备解锁、生产信任分发，
也没有 Linux 构建服务。桥接可以把设备端点绑到回环的 `ws://`；没有 TLS 证书时
`certificateFingerprint` 为 `null`，要求 `wss` 的物理 iPhone 构建会拒绝该端点。

生命周期恢复不保证在途工作的持久性：部署状态/发件箱对账、自动化状态持久化、跨重启的 Agent 唤醒归属、
精确的启动尝试身份、原生崩溃事件、不可变异步构建任务都仍是后续工作。标准预设同时包含通用 shell
与文件工具，因此窄生命周期 API 不是包住整个 Agent 的沙箱。

## 自检

```sh
npm run typecheck
npm run build
npm test
```

`npm test` 覆盖：协议与配对载荷校验、工具参数归一化、界面树边界、精确路由表、路由成功/失败 JSON、
桥接停止时的状态、三个工具注册与技能门控、工具级桥接失败、强制重装/去重语义、宿主弹窗路由、
多条件 `expect.checks`、隐藏节点过滤、设备 schema、`launch_host`、桥接身份/重启、devicectl
新旧格式解析、绑定/启动安全、离线自动恢复、真实桥接监督，以及在固定 `nsh` 存在时的实时构建验收。

侧栏与主面板插槽（`sidebar.panellist` 的 `jiezi`、`main` 的 `jiezi`）通过 Client slot 服务注册，
但它们的最终外观没有被单元测试渲染验证。
