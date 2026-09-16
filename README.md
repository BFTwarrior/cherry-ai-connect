# Cherry AI 连接中心 / Cherry AI Connect

一个面向 Cherry Studio 及其他 OpenAI 兼容客户端的本地 AI 连接管理桌面应用。

A local AI connection manager for Cherry Studio and other OpenAI-compatible clients.

## 项目状态 / Project status

`1.00` 正在进行候选版验收。源码、自动测试和本地安装包已经生成，但在完成真实 GitHub 私有仓库同步、Cherry Studio 实际请求、安装/卸载和托盘验收前，不标记为正式发布完成。

Version `1.00` is in release-candidate validation. Source, automated tests, and a local installer exist, but the release is not final until real private-GitHub sync, Cherry Studio, install/uninstall, and tray checks pass.

## 它能做什么 / Features

- 管理多个上游线路，每个客户端 Key 只绑定一条线路。
- 客户端 Key 默认跟随线路名称；用户手动改名后停止自动同步名称。
- 支持 `low`、`medium`、`high`、`xhigh`、`max` 五档思考强度。
- 自动读取并按线路分组显示模型目录。
- 提供永久累计 Token、24 小时至半年趋势、缓存命中率和实时请求记录。
- 本地请求明细以 50 MB 为上限；只有超限后才清理最早明细，永久累计不会归零。
- 支持深灰紫色中英文界面、托盘、开机启动、关闭到托盘和手动检查更新。
- 重置连接服务时使用安全随机方式从 29,000 个候选端口中选择可用端口。
- 可将加密后的线路配置和匿名使用量同步到用户自己的 GitHub 私有 Release。

## 快速下载 / Quick download

- [Release 页面 / Release page](https://github.com/BFTwarrior/cherry-ai-connect/releases/latest)
- [Windows x64 安装包 / Windows x64 installer](https://github.com/BFTwarrior/cherry-ai-connect/releases/download/v1.00/Cherry-AI-Connect-Setup-1.00.exe)
- 直达链接已固定；只有当 v1.00 Release 页面显示该附件后，才可下载。当前上传状态以 Release 页面为准。
- 安装包 SHA-256：`842F78771926370A614C97F47E00C785ADB5255D0AA36BDF4DEFAAA6227591EC`
- Installer SHA-256: `842F78771926370A614C97F47E00C785ADB5255D0AA36BDF4DEFAAA6227591EC`

## 安全边界 / Security boundary

- 连接服务只监听 `127.0.0.1`，不会直接开放到局域网或互联网。
- 上游 API Key 使用本机加密保存；完整客户端 Key、聊天正文、密码、恢复码和 GitHub 令牌不会上传。
- 云端敏感配置使用 Argon2id + AES-256-GCM 信封加密。
- GitHub 仓库必须为私有；发现公开仓库时同步会保护性停止。
- GitHub 访问令牌由 Windows 安全存储保护，不写入源码、日志或云端附件。

- The service listens only on `127.0.0.1`.
- Upstream keys are encrypted locally. Full client keys, prompts, responses, passwords, recovery codes, and GitHub tokens never upload.
- Cloud secrets use Argon2id plus AES-256-GCM envelope encryption.
- Sync stops if the selected GitHub repository is public.
- Windows secure storage protects the local GitHub credential.

## 本地数据与缓存 / Local data and cache

正式安装版把运行数据统一放在软件安装目录旁：

```text
<安装目录>\data\
├─ browser-cache\             Electron 浏览器缓存
├─ desktop-settings.json      桌面设置与当前端口
└─ gateway-data\
   ├─ config.json             线路、客户端 Key 摘要与设置
   ├─ usage.db                使用明细、永久总账和同步队列
   ├─ device.json             本机和同步数据集身份
   ├─ vault.enc               加密云端保险箱
   └─ sync-state.json         云同步状态
```

安装到 D 盘时，主要数据和缓存也位于 D 盘，不固定占用 C 盘。开发环境使用项目根目录下的 `.runtime-data`。

**请勿误删、移动、重命名或覆盖 `data` 及其中的记录文件。删除整个软件文件夹会同时删除缓存、线路、客户端 Key、永久统计和未同步数据。需要保留数据时，先完成云同步或备份整个 `data` 文件夹。**

Packaged runtime data lives in the `data` folder beside the installed app. Installing on drive D keeps the primary cache on drive D. Development uses `.runtime-data` inside the project.

**Do not accidentally delete, move, rename, or overwrite `data`. Deleting the app folder also deletes caches, routes, client keys, lifetime analytics, and unsynced data. Sync or back up the full folder first if the records must be kept.**

## GitHub 云同步 / GitHub cloud sync

当前候选版使用用户创建的 GitHub 访问令牌连接一个专用私有仓库，并在固定的 `cherry-sync` Release 中保存不可变、压缩和校验过的附件。默认每 30 分钟检查一次；开启、关闭、启动、退出、手动同步和安全配置变化会额外触发同步。

如果两台设备修改了不同版本的线路配置，程序进入冲突状态并要求用户选择“保留本机”或“恢复云端”，不会静默覆盖上游 Key。使用事件按唯一编号去重，永久统计使用分设备计数器合并。

The release candidate uses a user-created GitHub access token, one private repository, and one fixed `cherry-sync` Release. Immutable compressed assets are verified before the manifest is committed. Automatic checks run every 30 minutes and on major lifecycle events.

Configuration conflicts require an explicit local-or-cloud choice. Usage events deduplicate by ID, and lifetime totals merge through per-device counters.

## 安装 / Installation

公开稳定版和后续 1.00 发布位于：

- [Release 页面 / Release page](https://github.com/BFTwarrior/cherry-ai-connect/releases/latest)

当前 1.00 安装包直达地址：[Cherry-AI-Connect-Setup-1.00.exe](https://github.com/BFTwarrior/cherry-ai-connect/releases/download/v1.00/Cherry-AI-Connect-Setup-1.00.exe)。
如果 Release 页面暂时没有该附件，说明上传尚未完成，不能把这个地址当作已可下载。
SHA-256：`842F78771926370A614C97F47E00C785ADB5255D0AA36BDF4DEFAAA6227591EC`。

程序尚未进行商业代码签名，Windows SmartScreen 可能显示“未知发布者”。只应从本项目官方 Release 下载，并在安装前核对 SHA-256。

## 开发与构建 / Development and build

需要 Node.js 和 npm。最终用户安装 EXE 后不需要另外安装 Node.js、npm、pnpm 或 SQLite。

```bash
npm install
npm run check
npm test
npm run renderer:build
npm start
npm run dist
```

Build output is placed in `dist/` and is intentionally excluded from source commits. Publish installers as GitHub Release assets.

## 技术栈 / Stack

- Electron 44
- React 19 + TypeScript + Vite
- Node.js local connection service
- Built-in SQLite usage ledger
- Argon2id + AES-256-GCM encrypted vault
- GitHub Release Asset sync
- electron-builder NSIS packaging

## 代码结构 / Project structure

```text
electron/       桌面主进程、托盘、窗口、安装路径和 IPC
gateway/        本地 OpenAI 兼容连接服务、鉴权和转发
renderer/       React + TypeScript 桌面界面
sync/           加密保险箱、GitHub 适配器和同步协议
tests/          自动回归、故障注入和视觉验收入口
产品文档/       产品、使用、测试、验收和发布文档
```

## 文档入口 / Documentation

- `产品文档/1.00-实现现状与验收报告.txt`：当前 1.00 唯一现状依据。
- `产品文档/1.00-浏览器视觉验收方法与操作记录.txt`：浏览器预览、模拟接口、截图和验收边界。
- `产品文档/1.00-最终实施方案（架构审计收敛版）.txt`：设计基线与未完成门槛。
- `产品文档/测试人员完整说明.txt`：测试人员执行顺序。
- `产品文档/使用说明.txt`：最终用户操作说明。
- `产品文档/UI小功能测评问题清单.txt`：历史问题与状态；“待验收”和“待用户验收”不得混淆。

## 双语注释 / Bilingual comments

核心模块使用中文和英文成对注释，说明职责、安全边界和失败处理。公开仓库只能包含源码、文档和不含凭证的测试数据。

Core modules use paired Chinese and English comments for responsibilities, safety boundaries, and failure handling. Public commits must never contain real credentials.

## 许可证 / License

MIT
