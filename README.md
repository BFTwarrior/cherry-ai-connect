# Cherry Gateway / Cherry 多线路网关

一个面向 Cherry Studio 及其他 OpenAI 兼容客户端的本地多线路网关桌面应用。

A local multi-route gateway desktop application for Cherry Studio and other OpenAI-compatible clients.

## 项目简介 / Overview

Cherry Gateway 在本机提供一个统一的 API 地址。客户端只需要使用本地生成的客户端 Key；真实的上游中转站 Key 保存在本机，并由网关转发请求。

Cherry Gateway exposes one local API endpoint on the user's computer. Clients use locally generated client keys, while upstream provider keys stay local and are used only by the gateway.

## 主要功能 / Features

- 多个上游中转站线路 / Multiple upstream provider routes
- 一个客户端 Key 绑定一条线路 / One client key bound to one route
- 五档思考强度：low、medium、high、xhigh、max / Five reasoning levels
- 模型目录同步与线路分组 / Model catalog synchronization grouped by route
- 网关重置并随机分配本地端口 / Gateway reset with a randomized local port
- 深灰紫色桌面界面，支持中文与英文 / Dark-gray and purple desktop UI with Chinese and English
- 托盘、开机启动、关闭窗口进入托盘 / Tray, auto-start, and close-to-tray options

## 技术栈 / Stack

- Electron
- React + TypeScript + Vite
- Node.js local gateway
- electron-builder for Windows packaging

## 开发环境 / Development

需要 Node.js 和 npm。

Node.js and npm are required.

```bash
npm install
npm run check
npm run renderer:build
npm start
```

## 构建 Windows 安装包 / Build the Windows installer

```bash
npm run dist
```

构建产物位于 `dist/`。该目录默认不提交到源码仓库；正式发布时建议作为 GitHub Release 附件上传。

Build output is placed in `dist/`. The directory is intentionally ignored from source commits; publish the installer as a GitHub Release asset instead.

## 代码结构 / Project structure

```text
electron/       Electron 主进程、预加载桥接 / Main process and preload bridge
gateway/        本地 API 网关 / Local API gateway
renderer/       React + TypeScript UI / React + TypeScript interface
产品文档/       产品目标、要求、测试和验收文档 / Product and QA documentation
```

## 文档入口 / Documentation

交付总览和文档阅读顺序：
`产品文档/00-交付总览与文档索引.txt`

公开仓库上传前检查：
`产品文档/0.4.3-上传前检查报告.txt`

测试人员执行稿：
`产品文档/测试人员完整说明.txt`

用户使用说明：
`产品文档/使用说明.txt`

问题清单和最新状态：
`产品文档/UI小功能测评问题清单.txt`

The delivery index is the source of truth for document order, product boundaries, test status, and security rules. Historical sections remain for traceability; the latest delivery summary takes precedence.

## 本地数据 / Local runtime data

打包版运行数据由应用打开：进入“设置 > 打开数据目录”。通常位于 Electron userData 下的 `gateway-data` 子目录。该目录可能包含 `config.json` 和 `.gateway-secret`，不要提交到公开仓库、Issue 或截图。

The current 0.4.3 build uses local JSON configuration and AES-256-GCM encryption for upstream keys. SQLite is not required by this version.

## 验收顺序 / Acceptance order

健康检查 → 线路检测与模型同步 → 临时客户端 Key 生命周期 → 五档思考强度 → Cherry Studio 实际请求 → 中英文与托盘 → 重置网关 → 清理临时数据。

Do not record upstream keys or complete client keys in test artifacts. “待验收” and “待用户验收” are different statuses; see the delivery index before changing either one.

## 数据与安全 / Data and security

- 上游 Key 不应写入源码、README、Issue 或公开提交记录。
- Upstream keys must never be placed in source code, README files, issues, or public commits.
- 本地运行数据和密钥文件由 `.gitignore` 排除。
- Local runtime data and credential files are excluded by `.gitignore`.
- 公开仓库只应包含源码、文档和不含密钥的示例配置。
- A public repository should contain only source code, documentation, and credential-free example configuration.

## 双语注释约定 / Bilingual comment convention

核心模块使用成对的中文和英文注释，先说明模块职责，再说明关键安全边界。

Core modules use paired Chinese and English comments. Each module comment explains its responsibility and important security boundary.

## 许可证 / License

MIT
