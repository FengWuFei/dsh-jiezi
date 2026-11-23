# Changelog

本文件记录每个公开发布版本的变更；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- 技能与常驻提示词明确：当前宿主会为每个小程序注册并声明全部已评审的
  `jiezi/native` 原生组件，无需逐应用授权；新增原生能力仍需宿主版本和明确用户同意。

## [1.1.0] - 2026-11-23

### 新增

- `miniapp_doctor`：一次返回桥接身份、nsh、宿主版本/兼容性、配对、自动化与 CoreDevice 目标；
  `fix: true` 只回写失灵的 `nshPath` 并重启身份不一致的桥接，不创建信任材料、不配对、不启动宿主。
- `miniapp_reload` 与 `miniapp_deploy { force: true }`：用新的操作 id 重新安装/启动当前 release，
  用于清掉卡住的实例或宿主弹窗；普通重复部署返回 `reinstalled: false` 与下一步动作。
- `miniapp_device { action: "launch_host" }`：不需要已配对的 `deviceId`，按 `hostDeviceId`、绑定或
  唯一可见目标启动宿主。
- `miniapp_action` 的 `expect.checks`：一次断言多个带 testID 的作用域条件；`miniapp_ui` /
  `miniapp_action` 支持 `includeHidden`。
- 面板显示桥接 socket、项目根目录、nsh 路径/版本、桥接安装哈希与宿主版本；新增「重启桥接」「检测环境」；
  配对二维码显示倒计时并在过期后自动换一张。

### 修复

- 桥接升级后进程仍是旧代码：health 增加安装根/模块哈希/启动时间，supervisor 据此重启自己拉起或可证明
  属于本安装的旧进程；无法证明归属时以 `bridge_identity_mismatch` 失败而不是误杀。桥接每次 init/build
  重新解析 `nsh`，`doctor --fix` 可回写失灵的路径。
- `HOST_ALERT_BLOCKING` 不再与 `runtimeError` 混在一起：保留 appId/instanceId，附宿主版本/最低要求，
  错误信息要求更新宿主或清除弹窗，不再建议重复部署小程序。
- 语义快照去除与可见节点同 testID 的隐藏节点，默认不渲染 hidden 节点，并在 `snapshotIssues` 报告剩余
  重复 testID。
- `miniapp_devices` 与 `miniapp_device list` 统一 schema，拆开 `jieziPaired` / `coreDevicePaired` /
  `hostRunning`，并带 `nextAction`。
- 面板「连接方式」此前显示项目根目录，现分开显示连接地址、桥接 socket 与项目根目录。
- 插件更新、DSH 重启或桥接重启后，面板和诊断会从 `~/.jiezi/devices.json` 的持久化设备记录恢复
  「已配对」，不再因为内存中的二维码会话消失而引导用户重复配对；已有设备仍使用原 token 自动重连。
- 旧二维码过期或随桥接重启失效时，不再遮盖仍然有效的设备配对；面板本地的过期状态也不能再触发不必要的
  二维码自动刷新，显式等待中的新设备配对不受影响。解除配对会立即清理本地配对卡片。
- 已配对卡片明确提示「插件更新后无需重新扫码」，添加设备改为次要的「配对另一台 iPhone」；设备列表标题
  改为「已配对设备」，不再把离线但已配对的设备排除在语义之外。
- 新增同版本桥接代码替换回归测试：重启后原 bearer token 可直接认证，设备 id 与配对时间保持不变。

### 变更

- 随包桥接快照升级到 `jiezi-bridge 0.3.4`。
- `miniapp_open` 文档明确：只打开未运行的已安装小程序，不重启运行中的实例；需要重启用 `miniapp_reload`。
- 脚手架/技能文档补充安全区与 `env(keyboard-inset-height)` 键盘避让、`Checkbox` 可见勾选与
  无障碍隐藏装饰元素的做法，并记录 `textDecorationLine` 在 iOS 尚未渲染的限制。

[1.1.0]: https://github.com/FengWuFei/dsh-jiezi/releases/tag/v1.1.0

## [1.0.3] - 2026-11-23

### 变更

- 插件图标按 DSH 官方 bundle 图标的规格重做：36×36 画布、方块落在 `8–28` 区间（9px 方块、2px 间距、
  1.5 圆角），去掉白底板，改用品牌蓝渐变。右下格仍是描边格，但里面那颗五角星改成按外接圆精确计算的
  正五角星（五点均分、内外径比 0.382），不再是手绘路径。
- 侧栏图标换成同一套 2×2 网格：三格实心 + 一格描边占位。DSH 侧栏按 16/18px 渲染这个位置，星形在这个
  尺寸只会糊成一团，因此小尺寸不再画星，只保留与插件图标一致的轮廓。

[1.0.3]: https://github.com/FengWuFei/dsh-jiezi/releases/tag/v1.0.3

## [1.0.2] - 2026-11-23

### 变更

- 侧栏面板改用 DSH 官方 UI 原子样式：状态胶囊取官方 `Tag` 的几何与配色（`999px`、`11px/17px`、
  `10–12%` 同色着色底 + 同色文字），按钮取官方 `Button` 紧凑尺寸（28px 高、`radius-sm`、
  透明底 + `0.5px` 内描边、hover/active 用官方交互色），主按钮改用会随主题翻转的
  `label-primary-foreground`。错误条从实心红底改为 `10%` 红色底，与官方结果条一致。

### 修复

- 「运行中」等状态标签此前是 `state-success-400` 实心绿底 + 近黑文字，与 DSH 官方 UI 的
  标签风格不一致；`刷新` 等按钮此前是 1px 边框 + 灰底的重描边样式，尺寸也不对齐官方控件。

[1.0.2]: https://github.com/FengWuFei/dsh-jiezi/releases/tag/v1.0.2

## [1.0.1] - 2026-11-23

### 修复

- 随包桥接按 `jiezi-nsh-darwin-arm64` 查找可选工具链。1.0.0 里还留着内部名
  `@local/jiezi-nsh`，导致装好可选依赖后 `nsh` 仍然「找不到」。

[1.0.1]: https://github.com/FengWuFei/dsh-jiezi/releases/tag/v1.0.1

## [1.0.0] - 2026-11-23

首个公开发布。对应内部 `@local/jiezi-builder` 0.8.3 的能力，包名独立为 `dsh-jiezi`，
并补齐公开分发需要的元数据与发布流程。

### 新增

- `miniapp_init`：从空目录初始化 Native Shell TSX 项目，并在构建前预检开发证书对 `appId` 的覆盖范围
  （结果里的 `signing` 与 `warnings`）。
- `projectLayout` 配置：默认 `working-directory`（会话工作目录本身就是项目根，目录必须为空）；
  `named-subdirectory` 时建 `<工作目录>/<projectId>`。
- 自带的 `jiezi-miniapp` skill、十二个 `miniapp_*` 工具、`芥子开发模式` 预设、侧栏配对面板。
- 随包桥接快照 `vendor/bridge`（`jiezi-bridge` 0.3.3），Host 按精确版本锁复用它。
- 可选依赖 `jiezi-nsh-darwin-arm64@0.6.0`：macOS arm64 上开箱可用 `nsh`。

### 变更

- 包名 `@local/jiezi-builder` → `dsh-jiezi`；客户端模块 id、cordis 行名、skill 根解析同步更新。
- 声明 `engines.dsh`：`>=0.2.2-rc.1 <0.3.0`。

### 未验证

- 真机部署/视觉验证需要已配对设备，本次发布未在有物理设备的环境里跑完整链路。

[1.0.0]: https://github.com/FengWuFei/dsh-jiezi/releases/tag/v1.0.0
