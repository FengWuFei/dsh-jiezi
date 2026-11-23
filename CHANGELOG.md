# Changelog

本文件记录每个公开发布版本的变更；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
