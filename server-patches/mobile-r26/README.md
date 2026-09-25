# R25–R27 本机服务端累计补丁

本轮仅已应用到 `output/mobile-r25/server` 隔离测试副本；**没有部署正式服**。

- `mobile-r26.patch` 保留原交接路径，现含 R27 修复；是基于本机 `D:/网站/功能/AIXingYue-main/tools` 原始四个模块生成的 **R25–R27 累计补丁**。不要在 R25 或先前 R26 补丁之上机械叠加。生产实际基线不一致时须先比对再合并，不得强行覆盖。
- 含公共模型显示名/分组、创作资源导入校验、界面模板与旧正则资源兼容列表及版本引用、会话绑定后的实际正则应用。
- 正则替换不再被静默截为 240000 字符。单条上限为 8 MiB UTF-8，超限明确拒绝保存。旧数据仅在同一保存快照中有唯一匹配原文、当前内容恰好为旧截断前缀时恢复；不改写数据库、不覆盖编辑、不复活删除规则。
- 新界面模板（正则）使用 `ui_template`；旧 `regex` 记录、资源 ID、版本类型原样保留。旧 HTML 模板保留，不伪造匹配所有消息的正则。
- 私有/闭源资源仍由服务端鉴权；客户端合并入口不改变访问权限。
- R27：`conversations/start` 的开场保存仅执行原生语义的源文本阶段规则，不再提前执行显示阶段或仅提示词规则。否则客户端第二次显示替换会把包含触发词的 HTML 模板嵌入自身。客户端同时精确识别旧的已渲染开场并恢复来源；不清空历史或关闭全部正则。

生成和验证（维护者用，不要求验收用户执行）：

```powershell
py -3.13 tools/build_mobile_r26_server_patch.py --host D:/网站/功能/AIXingYue-main --stage output/mobile-r25/server --patch server-patches/mobile-r26/mobile-r26.patch
py -3.13 -m unittest discover -s tools/tests -p 'test_mobile_r*_host.py' -v
git -C D:/网站/功能/AIXingYue-main apply --check C:/CodexWork/homer-community-r9/server-patches/mobile-r26/mobile-r26.patch
```

正式发布时客户端和服务端须一起核验。只替换 APK，旧服务器仍可能截断角色卡或无法列出合并资源。客户端完整累计补丁是 `web-patches/20260925-2328-complete-web-mobile-r27.patch`，相对锁定 Web pin 导出；已在隔离 Git index 中应用并与工作源码比对，包含此前功能，不能只提交 `.web-cache` 外的壳层文件。
