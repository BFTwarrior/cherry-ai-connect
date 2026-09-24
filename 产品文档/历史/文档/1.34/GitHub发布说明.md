# Cherry AI Connect v1.34

## 中文

- 收紧顶部思考强度菜单的选项留白，并将设置页默认思考强度选择器居中。
- 说明同步冲突中的保险库密码/恢复码不是上游 API Key；已解锁的本机保险库选择“保留本机”时不再要求重复输入密码，云端恢复仍保留加密验证。
- 自动更新失败或安装包缺少可信校验值时，可前往 GitHub 官方发布页手动下载；未经校验的安装包仍不会运行。
- 不改变使用统计菜单，不覆盖本地记录、用户设置、客户端 Key 或同步凭证。

自动化验收：类型检查通过、37 项测试通过、渲染器构建通过、Windows x64 NSIS 安装包构建通过。

安装包：`Cherry-AI-Connect-Setup-1.34.exe`（103,139,473 bytes）

SHA-256：`7EC1604570FDB027844687C9E0ED9A2401051A6E084707303173F387DD6EA571`

SHA-512：`AB62B4883029FBF65B0C310E9FF764A36D629D63927A7B0AB8E425FC7FEC06C46D0180DCD065DE99805DC7D1B8DD0619B0B9719BD5E92C5132DD8F907D5811D6`

## English

- Removes excess whitespace from the top reasoning menu and centers the default reasoning selector in Settings.
- Clarifies that sync-conflict vault credentials are not upstream API keys. Keeping an already-unlocked local vault no longer asks for the password again; restoring cloud data remains encrypted and authenticated.
- Adds the official GitHub releases page as a manual fallback when automatic update fails or a trusted installer checksum is unavailable. Unverified installers are still never launched.
- Leaves usage analytics menus, local records, user settings, client keys, and sync credentials unchanged.

Automated checks: type check, all 37 tests, renderer build, and Windows x64 NSIS installer build passed.

Installer: `Cherry-AI-Connect-Setup-1.34.exe` (103,139,473 bytes)

SHA-256: `7EC1604570FDB027844687C9E0ED9A2401051A6E084707303173F387DD6EA571`

SHA-512: `AB62B4883029FBF65B0C310E9FF764A36D629D63927A7B0AB8E425FC7FEC06C46D0180DCD065DE99805DC7D1B8DD0619B0B9719BD5E92C5132DD8F907D5811D6`
