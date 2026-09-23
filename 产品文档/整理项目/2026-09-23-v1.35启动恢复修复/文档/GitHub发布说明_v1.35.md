# Cherry AI Connect v1.35

## 中文

- 修复 v1.34 在旧恢复指针已消费、本地数据缺失时发生的主进程启动崩溃；现在暂停启动并显示数据保护提示。
- 正式版运行数据改存于程序目录同级的独立文件夹。完整旧数据只复制迁移，不覆盖已有记录；恢复较旧备份须由用户明确选择，并提示备份之后的本地记录可能不在其中。
- 统计库缺失或为空、同步已启用但凭证缺失时保护性停止；同设备且未主动断开时可从匹配备份补回凭证。恢复复制先暂存校验，指针替换保留上一份副本。
- 不改变云同步协议、保险库加解密格式或既有客户端 Key。请尽量保持原安装路径；如更改路径，先核对旧数据目录，勿删除旧文件。

验证：类型检查、44 项自动化测试、渲染器构建、Windows x64 NSIS 安装包与 Web Demo 构建通过。隔离打包程序在不匹配的旧备份情形下显示保护提示，而非未捕获异常。目标设备的旧备份恢复、完整统计记录及真实 GitHub 同步仍待现场验收。

安装包：`Cherry-AI-Connect-Setup-1.35.exe`（103,141,088 bytes）
SHA-256：`EACC7623FE997E4F5CA489FA32386F300AF3290CE4E697FEA653D888A31DBB16`

## English

- Prevents the v1.34 main-process crash when a consumed recovery pointer meets missing local data; startup now stops with a protective dialog.
- Moves runtime data to a separate sibling folder. Complete legacy data is copied, never overwritten. Restoring an older backup requires explicit consent and may not include later local records.
- Stops on a missing or empty usage ledger or missing enabled-sync credential. Recovery copies are staged and verified before activation.
- Keeps the sync protocol, vault format, and existing client keys unchanged. Keep the installation path unchanged where possible; inspect the old data folder before changing it.

Checks passed: type check, 44 tests, renderer build, Windows x64 NSIS package, Web Demo build, and isolated packaged-startup protection. Recovery of the target device's records and live GitHub sync remain pending on-device acceptance.

Installer SHA-256: `EACC7623FE997E4F5CA489FA32386F300AF3290CE4E697FEA653D888A31DBB16`
