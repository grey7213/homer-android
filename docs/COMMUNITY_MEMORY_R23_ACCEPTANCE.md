# 297 本地验收：长记忆、关注/粉丝和留言规则

2026-09-20。实际源码 C:/CodexWork/homer-community-r9，Web 源码为该目录 .web-cache/tree。配套本机后端 D:/网站/功能/AIXingYue-main/tools。保留此前累计未提交改动，没有提交、上传或部署生产。

验收包：D:/网站/惑梦-关注粉丝与长记忆-297-debug.apk。包名 org.nebula.horizon.composeai.uireview，versionCode 297，Debug 签名。连接本机 192.168.1.129:8080，手机需在同一可互访 Wi-Fi；不是公网版本、不覆盖正式签名版、不改账号密码。使用原本机独立数据库，未清应用数据。

## 本次变化

- 关注/粉丝：根据小黑盒 APK 布局资源独立实现顶部切换、名单搜索、紧凑用户行与关系按钮；真实头像、简介、人数、回关/互关，搜索覆盖整个名单。保留既有“我的”入口。参照设备未登录，不能称为已完成账号页像素级对照；详见 HEYBOX_RELATIONS_R23_SPEC.md。
- 长记忆：按 Tavo 常用功能分层，首页提供我的记忆、立即总结、自动总结、频率、总结设置和高级设置。已用用户指定 PNG 在 Tavo 导入对照。真实 Memory Books 记忆编辑只开放 stmemorybooks 标记条目，保留原元数据；取消不保存，失败保留输入，旧版本冲突拒绝覆盖。自动设置仍是扩展原有账号全局作用域，页面明确标注。
- 普通用户自己的帖子可编辑；别人的帖子不可修改，旧版本提交不能覆盖新版本。
- 推广检测：社区新增/编辑/评论和实际角色卡评论入口共享规则与处罚。上下文组合判断，不因单独“私我/无偿”禁言；引用举报进入人工复核。违规内容不写入，处罚独立保存，后台可查看/解除，用户可申诉。默认先禁言 1 天（时长此前已询问，未获新选择），不永久封号。社区协议已加入对应范围。未发现已实现的私信发送接口，不能声称不存在的私信入口已接入。

## 验证命令与证据

- `py -3.13 tools/test_social_r23.py`：9 项通过，包括普通用户编辑、越权、处罚持久化、跨页搜索、人数、互关、隐私与拉黑过滤。
- `py -3.13 -m unittest discover -s tools -p 'test_community*.py'`：64 项通过。
- `py -3.13 tools/test_card_promotion_r23.py --backend-root D:/网站/功能/AIXingYue-main`：实际 Store 评论入口隔离测试通过。
- `node tools/test_memory_r23.mjs`：记忆过滤、保存、元数据、冲突、失败、换会话和删除通过。
- `py -3.13 tools/verify_social_r23.py`：390×844 深浅主题及 1440×900 浏览器通过。测试数据库合成用户，真实社区处理器，不改真实用户关系；搜索/清除/取消确认/回关/个人页返回/本人编辑通过，控制台及请求失败为零。output/social-r23/ 保存整页截图。
- `py -3.13 tools/verify_chat_runtime.py` 与 `--dark`：真实隔离对话运行时回归通过，原长按、编辑、回溯、模型/Mod/外观等保持。没有调用付费模型。
- `py -3.13 tools/verify_memory_host_r22.py`：真实扩展面板、范围、仅记忆条目可编辑、取消无写入/保存成功通过。API 使用隔离记忆数据。
- Gradle `testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview -PHOMER_DEBUG_VERSION_CODE=297 -PHOMER_DEBUG_SERVER_BASE_URL=http://192.168.1.129:8080/`：成功（最终 50 tasks，7 executed，43 up-to-date）。
- `py -3.13 tools/verify_apk_assets.py`：46.0 MB，资源清单 1178 条，170 个前端文件缺失 0。
- `adb -s emulator-5556 install -r .../app-debug.apk`：成功。Android API35 实际密码登录、退出重登、管理员服务权限、关注列表与返回、实际聊天长记忆首页已操作；详见 output/social-r23/android/android.json 和截屏。

## 限制

用户未进行最终视觉验收。没有配置参考 Tavo API，也未执行付费总结或对真实账号制造违规。Android 完整聊天初始化仍有等待：本轮首个全链路样本约 14 秒，第二次重复进入超过测试的 45 秒就绪时限，稍后只读复查时已就绪且有 1 条消息。运行时就绪后的长记忆打开测得约 1.5 秒和 5.2 秒（包含 CDP 触摸与检查开销），真实面板可以操作，但性能未达标，不能称为全链路全部通过或秒开。关注/粉丝单独验收另存 relations.json，不用这个问题掩盖或混淆该功能的测试结果。浏览器已就绪面板打开的毫秒数不能替代 Android 指标。
