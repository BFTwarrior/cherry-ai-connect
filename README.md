# Cherry AI 连接中心 / Cherry AI Connect

一个面向 Cherry Studio 及其他 OpenAI 兼容客户端的本地 AI 连接管理桌面应用。

A local AI connection manager for Cherry Studio and other OpenAI-compatible clients.

## 项目状态 / Project status

`1.00` 已创建正式 GitHub Release 并上传 Windows 安装包。真实 GitHub 私有仓库同步、Cherry Studio 实际请求、安装/卸载和托盘验收仍建议按测试文档逐项执行。

Version `1.00` has a published GitHub Release with the Windows installer attached. Real private-GitHub sync, Cherry Studio requests, installation/uninstallation, and tray checks should still be verified using the tester guide.

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
- v1.00 安装包附件已上传；下载前可在 Release 页面核对文件名和 SHA-256。
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

## GitHub 云同步指南 / GitHub Cloud Sync Guide

### 先理解两个仓库 / Understand the two repositories first

| 仓库 / Repository | 用途 / Purpose | 是否影响同步 / Sync impact |
| --- | --- | --- |
| `BFTwarrior/cherry-ai-connect` | 公开源码、README、安装包 / Public source code, README, and installer | 修改这里的 README 不影响同步 / Editing this README does not affect sync |
| `cherry-ai-connect-sync` | 用户自己的私有加密同步仓库 / Your private encrypted sync repository | Cherry AI 连接中心实际读写这里 / Cherry AI Connect reads and writes here |

重要 / Important：不要把公开源码仓库用作同步仓库。程序发现同步仓库为公开状态时，会为保护数据而停止同步。同步仓库可以改名，但必须把软件“私有仓库名称”同步改成完全相同的名称。

Do not use the public source repository as the sync repository. Sync stops when the selected sync repository is public. If you rename the private sync repository, update the app’s “Private repository name” field to exactly the same name.

### 创建令牌时的完整选择 / Exact token settings

打开 [GitHub Fine-grained token settings](https://github.com/settings/personal-access-tokens)，点击 `Generate new token`。

Open [GitHub Fine-grained token settings](https://github.com/settings/personal-access-tokens) and click `Generate new token`.

| 页面项目 / Page field | 中文怎么选 / Chinese instruction | English instruction |
| --- | --- | --- |
| `Token name` | 填 `Cherry AI Connect Sync`，只是方便识别 | Enter `Cherry AI Connect Sync`; this is only a label |
| `Description` | 填“用于 Cherry AI 连接中心云同步” | Enter `For Cherry AI Connect cloud sync` |
| `Resource owner` | 选择自己的 GitHub 账号“BFT战士” | Select your own GitHub account, `BFT战士` |
| `Expiration` | 建议 180 天或 1 年；无过期不是错误，但长期风险更高 | Choose 180 days or 1 year; no expiration is allowed but has higher long-term risk |
| `Repository access` | 选择 `Only select repositories` | Select `Only select repositories` |
| `Select repositories` | 只选择私有同步仓库 `BFTwarrior/cherry-ai-connect-sync` | Select only the private sync repository `BFTwarrior/cherry-ai-connect-sync` |

#### 权限页面具体怎么点 / Exact permission clicks

你截图中的 `Permissions` 区域一开始显示 `Repositories 0`，这是正常的，表示还没有添加仓库权限。

In the screenshot, `Repositories 0` is normal at first. It means no repository permission has been added yet.

1. 点击 `Add permissions`。

   Click `Add permissions`.

2. 在搜索框输入 `Contents`，选择 `Contents`。

   Search for `Contents` and select `Contents`.

3. 在 `Contents` 右侧的权限级别中选择 `Read and write`。

   Set the `Contents` access level to `Read and write`.

4. `Metadata` 如果自动出现，保持 `Read-only`；不要额外添加其他权限。

   If `Metadata` appears automatically, leave it as `Read-only`; do not add other permissions.

5. 最终应满足：`Repositories 1`、选中同步仓库 1 个、`Contents: Read and write`、`Metadata: Read-only`。

   Final result: one selected repository, `Contents: Read and write`, and `Metadata: Read-only`.

不需要选择 / Do not select：`Actions`、`Administration`、`Agent secrets`、`Agent tasks`、`Agent variables`、`Issues`、`Pull requests`、`Secrets` 或其他无关权限。不要选择 `All repositories`。

You do not need `Actions`, `Administration`, `Agent secrets`, `Agent tasks`, `Agent variables`, `Issues`, `Pull requests`, `Secrets`, or any unrelated permission. Do not select `All repositories`.

GitHub 官方建议使用细粒度令牌，并限制到指定仓库和最低权限。[GitHub 官方令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

GitHub recommends fine-grained tokens with access limited to the required repository and minimum permissions.

### 生成后如何连接软件 / Connect the token to the app

1. 点击 `Generate token`。
2. 生成成功后立即复制完整令牌；完整值只显示这一次。
3. 打开 Cherry AI 连接中心：`设置 → GitHub 云同步`。
4. 粘贴到 `GitHub 访问令牌`。
5. `私有仓库名称` 填 `cherry-ai-connect-sync`，或填写你实际创建的同步仓库名称。
6. 填写至少 8 位的备份加密密码，并再次确认。
7. 点击 `连接 GitHub 并开启同步`，再点击 `立即同步` 验证。

1. Click `Generate token`.
2. Copy the full token immediately; the full value is shown only once.
3. Open Cherry AI Connect: `Settings → GitHub cloud sync`.
4. Paste it into `GitHub access token`.
5. Set `Private repository name` to `cherry-ai-connect-sync`, or to your actual sync repository name.
6. Enter and confirm a backup vault password of at least 8 characters.
7. Click `Connect GitHub and enable sync`, then `Sync now` to verify.

### 查看有效期与更换令牌 / Check expiration and replace a token

在 [GitHub 令牌管理页](https://github.com/settings/personal-access-tokens) 可以查看令牌名称、有效期、权限和状态，但不能再次查看完整令牌。

On the [GitHub token management page](https://github.com/settings/personal-access-tokens), you can review the token name, expiration, permissions, and status, but you cannot view the full token again.

更换时不要删除 `data` 文件夹，也不要修改同步仓库和备份加密密码：

When replacing a token, do not delete the `data` folder or change the sync repository and vault password:

1. 按上面的权限重新创建一个新令牌。
2. 将新令牌填入软件。
3. 保持原来的私有仓库名称和备份加密密码。
4. 点击连接并立即同步，确认成功后再删除 GitHub 上的旧令牌。

1. Create a new token using the permissions above.
2. Enter the new token in the app.
3. Keep the same private repository name and vault password.
4. Connect and sync; revoke the old GitHub token only after the new sync succeeds.

令牌失效只会暂停云同步，本地线路和本地 AI 请求仍可继续使用。`401` 通常表示令牌过期、被撤销或无效；`403` 通常表示权限不足、仓库公开或触发限流；`404` 通常表示仓库名称不一致。

Token failure pauses cloud sync only; local routes and local AI requests continue to work. `401` usually means expired, revoked, or invalid token; `403` usually means insufficient permissions, a public repository, or rate limiting; `404` usually means a repository-name mismatch.

配置冲突会要求明确选择“保留本机”或“恢复云端”；程序不会静默覆盖线路和上游密钥。使用事件按编号去重，永久统计按设备计数器合并。

Configuration conflicts require an explicit “Keep this PC” or “Restore cloud copy” choice. The app never silently overwrites routes or upstream keys. Usage events deduplicate by ID, and lifetime totals merge through per-device counters.

## 安装 / Installation

公开稳定版和后续 1.00 发布位于：

- [Release 页面 / Release page](https://github.com/BFTwarrior/cherry-ai-connect/releases/latest)

当前 1.00 安装包直达地址：[Cherry-AI-Connect-Setup-1.00.exe](https://github.com/BFTwarrior/cherry-ai-connect/releases/download/v1.00/Cherry-AI-Connect-Setup-1.00.exe)。
如果未来某个版本的 Release 页面没有对应附件，说明该版本尚未完成发布，不能把直达地址当作已可下载。
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
