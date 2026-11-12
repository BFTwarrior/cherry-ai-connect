# 最终补充核对

- 迁移前config.json、.gateway-secret、device.json、usage.db复制到隔离网关后成功启动，dataset ID、原客户端Key和上游线路Key均一致。
- 对独立未初始化vault使用错误密码验证远端envelope时拒绝，未初始化或覆盖本机vault。
- 加强后的自动同步测试14/14通过；实现源码自247/247完整回归后仅补过已复审的原生协商头，并已重建最终安装包。
- 本地XMind74节点，子主题最大深度4（含中心共5层），水平右向结构，统一同级主题长度关闭，无批注；CLI validate零错误零警告，离线batch消耗0。
- 可交付安装包与验收JSON的SHA-256一致，未提交/推送/发布GitHub。
