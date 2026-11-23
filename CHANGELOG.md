# Changelog

本文件记录每个公开发布版本的变更；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
