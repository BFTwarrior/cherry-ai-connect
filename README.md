# Cherry AI 连接中心 / Cherry AI Connect

一个面向 Cherry Studio 及其他 OpenAI 兼容客户端的本地 AI 连接管理桌面应用。

A local AI connection manager for Cherry Studio and other OpenAI-compatible clients.

## 项目状态 / Project status

`1.00` 已创建正式 GitHub Release 并上传 Windows 安装包。真实 GitHub 私有仓库同步、Cherry Studio 实际请求、安装/卸载和托盘验收仍建议按测试文档逐项执行。

Version `1.00` has a published GitHub Release with the Windows installer attached. Real private-GitHub sync, Cherry Studio requests, installation/uninstallation, and tray checks should still be verified using the tester guide.

## 它能做什么 / Features

**中文**

- 管理多个上游线路，每个客户端 Key 只绑定一条线路。
- 客户端 Key 默认跟随线路名称；用户手动改名后停止自动同步名称。
- 支持 `low`、`medium`、`high`、`xhigh`、`max` 五档思考强度。
- 自动读取并按线路分组显示模型目录。
- 提供永久累计 Token、24 小时至半年趋势、缓存命中率和实时请求记录。
- 本地请求明细以 50 MB 为上限；只有超限后才清理最早明细，永久累计不会归零。
- 支持深灰紫色中英文界面、托盘、开机启动、关闭到托盘和手动检查更新。
- 重置连接服务时使用安全随机方式从 29,000 个候选端口中选择可用端口。
- 可将加密后的线路配置和匿名使用量同步到用户自己的 GitHub 私有 Release。

**English**

- Manage multiple upstream routes, with each client key bound to exactly one route.
- Client-key names follow the bound route by default; automatic renaming stops after the user enters a custom name.
- Support five reasoning levels: `low`, `medium`, `high`, `xhigh`, and `max`.
- Fetch model catalogs automatically and group models by route.
- Show lifetime token totals, trends from 24 hours to six months, cache hit rate, and live request records.
- Keep local request details up to 50 MB; only the oldest details are removed after the limit is exceeded, while lifetime totals remain intact.
- Provide a dark gray and purple bilingual interface, tray support, startup launch, close-to-tray behavior, and manual update checks.
- Reset the local connection service by securely selecting an available port from 29,000 candidates.
- Sync encrypted route configuration and anonymous usage totals to the user’s own private GitHub Release.

## 快速下载 / Quick download

- [Release 页面 / Release page](https://github.com/BFTwarrior/cherry-ai-connect/releases/latest)
- [Windows x64 安装包 / Windows x64 installer](https://github.com/BFTwarrior/cherry-ai-connect/releases/download/v1.00/Cherry-AI-Connect-Setup-1.00.exe)
- v1.00 安装包附件已上传；下载前可在 Release 页面核对文件名和 SHA-256。
- The v1.00 installer is attached to the Release. Verify its filename and SHA-256 before installing.
- 安装包 SHA-256：`842F78771926370A614C97F47E00C785ADB5255D0AA36BDF4DEFAAA6227591EC`
- Installer SHA-256: `842F78771926370A614C97F47E00C785ADB5255D0AA36BDF4DEFAAA6227591EC`

## 安全边界 / Security boundary

**中文**

- 连接服务只监听 `127.0.0.1`，不会直接开放到局域网或互联网。
- 上游 API Key 使用本机加密保存；完整客户端 Key、聊天正文、密码、恢复码和 GitHub 令牌不会上传。
- 云端敏感配置使用 Argon2id + AES-256-GCM 信封加密。
- GitHub 仓库必须为私有；发现公开仓库时同步会保护性停止。
- GitHub 访问令牌由 Windows 安全存储保护，不写入源码、日志或云端附件。

**English**

- The service listens only on `127.0.0.1`.
- Upstream keys are encrypted locally. Full client keys, prompts, responses, passwords, recovery codes, and GitHub tokens never upload.
- Cloud secrets use Argon2id plus AES-256-GCM envelope encryption.
- Sync stops if the selected GitHub repository is public.
- Windows secure storage protects the local GitHub credential.

## 本地数据与缓存 / Local data and cache

**中文说明**

正式安装版把运行数据统一放在软件安装目录旁：

```text
<安装目录>\data\
├─ browser-cache\             Electron 浏览器缓存 / Electron browser cache
├─ desktop-settings.json      桌面设置与当前端口 / Desktop settings and current port
└─ gateway-data\
   ├─ config.json             线路、客户端 Key 摘要与设置 / Routes, client-key summaries, and settings
   ├─ usage.db                使用明细、永久总账和同步队列 / Usage details, lifetime totals, and sync queue
   ├─ device.json             本机和同步数据集身份 / Device and sync-dataset identity
   ├─ vault.enc               加密云端保险箱 / Encrypted cloud vault
   └─ sync-state.json         云同步状态 / Cloud-sync state
```

安装到 D 盘时，主要数据和缓存也位于 D 盘，不固定占用 C 盘。开发环境使用项目根目录下的 `.runtime-data`。

**请勿误删、移动、重命名或覆盖 `data` 及其中的记录文件。删除整个软件文件夹会同时删除缓存、线路、客户端 Key、永久统计和未同步数据。需要保留数据时，先完成云同步或备份整个 `data` 文件夹。**

**English**

Packaged runtime data lives in the `data` folder beside the installed app. Installing on drive D keeps the primary cache on drive D. Development uses `.runtime-data` inside the project.

**Do not accidentally delete, move, rename, or overwrite `data`. Deleting the app folder also deletes caches, routes, client keys, lifetime analytics, and unsynced data. Sync or back up the full folder first if the records must be kept.**

## GitHub 云同步 / GitHub Cloud Sync

[中文教程](#中文云同步教程) · [English guide](#english-cloud-sync-guide)

> **隐私说明 / Privacy note**
>
> 截图使用示例账号 `your-account`，不包含真实令牌、真实账号或私人仓库信息。令牌只应粘贴到软件中，不要发给任何人，也不要放入截图、Issue 或公开仓库。
>
> The screenshot uses the example identity `your-account`. It contains no real token, account, or private repository information. Never share a token or place it in screenshots, issues, or public repositories.

### 最终正确状态 / Correct final state

![GitHub 细粒度令牌最终权限配置 / Final fine-grained token permissions](docs/images/github-sync/github-token-final-permissions.png)

**中文：** 这是生成令牌前唯一需要对照的验收图。确认只选择了 1 个私有同步仓库，`Contents` 为 `Read and write`，`Metadata` 为 `Read-only`，并且 `Account 0`。图中的账号和仓库所有者均已脱敏。

**English:** This is the only reference image you need before generating the token. Confirm that exactly one private sync repository is selected, `Contents` is `Read and write`, `Metadata` is `Read-only`, and the page shows `Account 0`. The account and repository owner are anonymized.

### 中文云同步教程

#### 1. 先分清两个仓库

| 仓库 | 用途 | 是否影响云同步 |
| --- | --- | --- |
| `BFTwarrior/cherry-ai-connect` | 本项目的公开源码、README 和安装包 | 修改这里的 README 不会改变你的同步数据 |
| `你的账号/cherry-ai-connect-sync` | 你自己创建的**私有**加密同步仓库 | 软件实际读取和写入这个仓库 |

> **不要把公开源码仓库当作同步仓库。** 为保护数据，软件检测到同步仓库是公开仓库时会停止同步。同步仓库可以改名，但软件中的“私有仓库名称”必须同时改成完全相同的名称。

#### 2. 创建细粒度 GitHub 令牌

1. 打开 [GitHub 细粒度令牌页面](https://github.com/settings/personal-access-tokens)，选择 `Generate new token`。
2. `Token name` 填写 `Cherry AI Connect Sync`。
3. `Description` 可填写“用于 Cherry AI 连接中心云同步”。
4. `Resource owner` 选择你自己的 GitHub 账号。
5. `Expiration` 建议选择 **180 天**或 **1 年**。`No expiration` 可以使用，但令牌长期泄露的风险更高。
6. `Repository access` 必须选择 `Only select repositories`。
7. 只选择你的私有同步仓库，例如 `your-account/cherry-ai-connect-sync`。

#### 3. 添加正确权限

1. 在 `Permissions` 区域点击 `Add permissions`。
2. 搜索并添加 `Contents`。
3. 把 `Contents` 右侧权限改成 `Read and write`。
4. `Metadata` 会由 GitHub 自动加入，保持 `Read-only` 即可。
5. 不要添加 `Actions`、`Administration`、`Agent secrets`、`Issues`、`Pull requests`、`Secrets` 或其他无关权限，也不要选择 `All repositories`。

完成后与上方“最终正确状态”截图逐项核对：

- `Only select repositories` 已选中；
- 只选择了 1 个私有同步仓库；
- `Repositories 2`，包含 GitHub 自动要求的两项仓库权限；
- `Contents` 是 `Read and write`；
- `Metadata` 是 `Read-only`；
- `Account 0`，没有添加任何账号级权限。

> 如果仍显示 `Repositories 0`，说明还没有添加 `Contents`，此时**不能**生成令牌。页面与上方截图一致后，再点击 `Generate token`。

GitHub 官方也建议使用细粒度令牌，并把权限限制在指定仓库和最低必要范围。参见 [GitHub 官方令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

#### 4. 把令牌连接到软件

1. 点击 `Generate token`。
2. 立即复制生成的完整令牌；GitHub 只会完整显示一次。
3. 打开 Cherry AI 连接中心，进入 `设置 → GitHub 云同步`。
4. 把令牌粘贴到 `GitHub 访问令牌`。
5. `私有仓库名称` 填写 `cherry-ai-connect-sync`，或填写你实际创建的同步仓库名称。
6. 设置并确认至少 8 位的备份加密密码。
7. 点击 `连接 GitHub 并开启同步`，再执行一次 `立即同步`。

#### 5. 查看有效期和更换令牌

在 [GitHub 令牌管理页](https://github.com/settings/personal-access-tokens) 可以查看令牌名称、到期时间、权限和状态，但不能再次查看完整令牌。

更换令牌时：

1. 按照上方步骤和最终状态截图创建新令牌；
2. 在软件中换成新令牌；
3. 保持原来的私有仓库名称和备份加密密码不变；
4. 连接并立即同步；
5. 确认同步成功后，再撤销 GitHub 上的旧令牌。

更换令牌不会清空同一私有仓库中的数据，也不会破坏同步记录；它只是在更换访问凭证。不要删除 `data` 文件夹、私有同步仓库或 Release 里的同步文件。

常见错误：`401` 通常表示令牌过期、被撤销或填写错误；`403` 通常表示权限不足、仓库为公开状态或触发限流；`404` 通常表示仓库名称与软件设置不一致。

---

### English Cloud Sync Guide

#### 1. Understand the two repositories

| Repository | Purpose | Effect on cloud sync |
| --- | --- | --- |
| `BFTwarrior/cherry-ai-connect` | Public source code, README, and installer | Editing this README does not change your sync data |
| `your-account/cherry-ai-connect-sync` | Your private encrypted sync repository | This is the repository the app reads and writes |

> **Do not use the public source repository as the sync repository.** To protect your data, the app stops syncing if the selected repository is public. You may rename the private sync repository, but the app’s `Private repository name` must be updated to exactly the same name.

#### 2. Create a fine-grained GitHub token

1. Open [GitHub fine-grained token settings](https://github.com/settings/personal-access-tokens) and choose `Generate new token`.
2. Set `Token name` to `Cherry AI Connect Sync`.
3. Optionally set `Description` to `For Cherry AI Connect cloud sync`.
4. Select your own GitHub account as the `Resource owner`.
5. Choose an `Expiration` of **180 days** or **1 year**. `No expiration` works, but creates more long-term risk if the token is exposed.
6. Under `Repository access`, select `Only select repositories`.
7. Select only your private sync repository, for example `your-account/cherry-ai-connect-sync`.

#### 3. Add the minimum required permissions

1. In `Permissions`, click `Add permissions`.
2. Search for and add `Contents`.
3. Set `Contents` to `Read and write`.
4. GitHub adds `Metadata` automatically; leave it at `Read-only`.
5. Do not add `Actions`, `Administration`, `Agent secrets`, `Issues`, `Pull requests`, `Secrets`, or unrelated permissions. Do not select `All repositories`.

Compare the result with the single “Correct final state” screenshot above:

- `Only select repositories` is selected;
- exactly one private sync repository is selected;
- `Repositories 2` includes the two repository permissions required by GitHub;
- `Contents` is `Read and write`;
- `Metadata` is `Read-only`;
- `Account 0` confirms that no account-level permission was added.

> If the page still shows `Repositories 0`, `Contents` has not been added yet. **Do not** generate the token until the page matches the screenshot above.

GitHub recommends fine-grained tokens restricted to the required repository and minimum permissions. See [GitHub’s official token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

#### 4. Connect the token to the app

1. Click `Generate token`.
2. Copy the complete token immediately; GitHub displays the full value only once.
3. Open Cherry AI Connect and go to `Settings → GitHub Cloud Sync`.
4. Paste the token into `GitHub access token`.
5. Set `Private repository name` to `cherry-ai-connect-sync`, or to the exact name of your private sync repository.
6. Enter and confirm a backup vault password of at least 8 characters.
7. Click `Connect GitHub and enable sync`, then run `Sync now` once.

#### 5. Check expiration and replace a token

The [GitHub token management page](https://github.com/settings/personal-access-tokens) shows the token name, expiration, permissions, and status. It does not reveal the full token again.

To replace a token:

1. Create a new token using the steps and final-state screenshot above;
2. enter the new token in the app;
3. keep the same private repository name and backup vault password;
4. connect and run an immediate sync;
5. revoke the old token only after the new sync succeeds.

Replacing a token does not erase data in the same private repository or break sync history. It only replaces the access credential. Do not delete the `data` folder, the private sync repository, or its release files.

Common errors: `401` usually means an expired, revoked, or mistyped token; `403` usually means insufficient permissions, a public repository, or rate limiting; `404` usually means the repository name does not match the app setting.

## 安装 / Installation

**中文说明**

当前稳定版 v1.00 的安装包和发布说明位于：

- [Release 页面 / Release page](https://github.com/BFTwarrior/cherry-ai-connect/releases/latest)

当前 1.00 安装包直达地址：[Cherry-AI-Connect-Setup-1.00.exe](https://github.com/BFTwarrior/cherry-ai-connect/releases/download/v1.00/Cherry-AI-Connect-Setup-1.00.exe)。
如果未来某个版本的 Release 页面没有对应附件，说明该版本尚未完成发布，不能把直达地址当作已可下载。
SHA-256：`842F78771926370A614C97F47E00C785ADB5255D0AA36BDF4DEFAAA6227591EC`。

程序尚未进行商业代码签名，Windows SmartScreen 可能显示“未知发布者”。只应从本项目官方 Release 下载，并在安装前核对 SHA-256。

**English**

The installer and release notes for the current stable v1.00 are available here:

- [Release page](https://github.com/BFTwarrior/cherry-ai-connect/releases/latest)

Direct download: [Cherry-AI-Connect-Setup-1.00.exe](https://github.com/BFTwarrior/cherry-ai-connect/releases/download/v1.00/Cherry-AI-Connect-Setup-1.00.exe). If a future Release page does not contain its installer asset, that version has not been fully published and its direct-download link should not be treated as available. SHA-256: `842F78771926370A614C97F47E00C785ADB5255D0AA36BDF4DEFAAA6227591EC`.

The installer is not commercially code-signed, so Windows SmartScreen may show “Unknown publisher.” Download only from this project’s official Release page and verify the SHA-256 before installation.

## 开发与构建 / Development and build

**中文：** 开发环境需要 Node.js 和 npm。最终用户安装 EXE 后不需要另外安装 Node.js、npm、pnpm 或 SQLite。

**English:** Development requires Node.js and npm. End users who install the EXE do not need to install Node.js, npm, pnpm, or SQLite separately.

```bash
npm install
npm run check
npm test
npm run renderer:build
npm start
npm run dist
```

构建产物位于 `dist/`，并且不会提交到源码仓库。安装包应作为 GitHub Release 附件发布。

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
electron/       桌面主进程、托盘、窗口、安装路径和 IPC / Desktop process, tray, windows, install paths, and IPC
gateway/        本地 OpenAI 兼容连接服务、鉴权和转发 / Local OpenAI-compatible service, authentication, and forwarding
renderer/       React + TypeScript 桌面界面 / React and TypeScript desktop UI
sync/           加密保险箱、GitHub 适配器和同步协议 / Encrypted vault, GitHub adapter, and sync protocol
tests/          自动回归、故障注入和视觉验收入口 / Automated regression, fault injection, and visual acceptance entry points
产品文档/       产品、使用、测试、验收和发布文档 / Product, usage, testing, acceptance, and release documents
```

## 文档入口 / Documentation

- `产品文档/00-交付总览与文档索引.txt`：当前文档入口、版本口径和文件边界。/ Current document index, version rules, and file boundaries.
- `产品文档/产品目标.txt`、`产品文档/产品要求.txt`：产品定位、功能规则和安全边界。/ Product goals, functional rules, and safety boundaries.
- `产品文档/使用说明.txt`：最终用户配置、使用和同步说明。/ End-user setup, usage, and sync instructions.
- `产品文档/测试人员完整说明.txt`：按顺序执行的现场验收步骤。/ Ordered field acceptance steps for testers.
- `产品文档/1.00-实现现状与验收报告.txt`：当前 1.00 唯一现状依据。/ The single source of truth for the current v1.00 implementation status.
- `产品文档/UI小功能测评问题清单.txt`：当前验收矩阵和剩余现场补测。/ Current acceptance matrix and remaining field checks.
- `产品文档/1.00-浏览器视觉验收方法与操作记录.txt`：浏览器视觉验收边界。/ Browser visual acceptance boundaries.
- `产品文档/1.1-下一版本修复与增加计划.txt`：1.1 待处理问题和验收标准。/ v1.1 pending issues and acceptance criteria.
- `产品文档/版本说明.txt`、`产品文档/踩坑记录.txt`：简要参考。/ Quick references.

## 双语注释 / Bilingual comments

核心模块使用中文和英文成对注释，说明职责、安全边界和失败处理。公开仓库只能包含源码、文档和不含凭证的测试数据。

Core modules use paired Chinese and English comments for responsibilities, safety boundaries, and failure handling. Public commits must never contain real credentials.

## 许可证 / License

MIT
