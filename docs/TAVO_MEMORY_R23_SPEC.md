# Tavo 长记忆 → HTML/CSS 独立实现规格

参照：用户提供的 `D:/网站/tavo/tavo最新新.apk`，1.5.0。只提取界面行为与设置结构，不把其商业代码或资源加入产品。当前选用用户指定的“爱情公寓蜗牛制作.png”进行对照，不调用模型。

## 已确认的编译资源线索

解包目录 `output/ui-models-r12/decoded` 中没有 Dart 源码或 source map。长记忆设置不在可读的对话 WebView bundle 里，位于 arm64 `libapp.so` 编译资源。

可识别的设置键：`ext_ltm_chat_settings_manage`、`ext_ltm_chat_settings_manual_update`、`ext_ltm_settings_frequency`、`ext_ltm_settings_endpoint`、`ext_ltm_settings_summary_prompt`、`ext_ltm_settings_limit`、`ext_ltm_settings_injection_position`、`ext_ltm_settings_injection_depth`。对应管理记忆、手动总结、频率、独立模型、总结指令和注入配置。

可识别状态：自动总结、立即总结、无消息、总结中、失败、成功；记忆数据有 enabled 与 memories，支持追加与更新。

这些证据说明功能分层，不足以恢复原始 Flutter 组件树或精确尺寸；不声称已自动转换原始 UI 源码。

## 本项目映射与验收

- 常用首页：记忆状态、立即总结、自动总结、管理记忆；范围默认可用，非强制多步向导。
- 自动总结：用真实 Memory Books 设置，不在打开界面时默认开启或触发付费生成；清楚显示作用域和首次手动整理要求。
- 手动总结：保留现有起止范围与原始生成按钮处理器，生成前保留确认与费用提示。
- 专业设置：原有模型、保存位置、指令、压缩等能力保留在二级页面，返回不丢选项。
- 不能把创作者世界书全文暴露为记忆列表；只允许显示扩展标识的记忆条目。
- 首次/热开、亮暗主题、返回、空消息、取消与保存都需在真实扩展运行时验证。

## 进度

2026-09-20：已在 Tavo 1.5.0 导入用户指定的 PNG（世界书与正则同时导入），创建本地对话。实测右抽屉的长记忆开关开启后展开 Memories（数量）与 Summarize now（旁注 auto after 10 msg）；记忆页是独立编辑页，说明每行一个记忆点，底部保存。未配置参考软件模型，点击总结返回缺少 API 提示，没有付费生成。截图见 output/r23-tavo-memory-drawer.png、r23-tavo-memory-editor.png。

实现差异：本扩展以结构化记忆条目存储，不把多条记录拼成一个文本后破坏条目 ID、触发范围及合并层级；采用记忆列表进入单条编辑。自动整理沿用扩展既有设置作用域并明确标注，不把全局设置冒充仅当前会话。
