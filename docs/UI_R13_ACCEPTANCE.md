# Android R13 测试包验收

源码：`C:/CodexWork/homer-community-r9`。前端与运行时使用该工作区 `.web-cache/tree` 的实际内容，不是旧目录副本。仅本地构建，没有 commit/push/部署。

交付包：`D:/网站/惑梦-界面重构R13-debug-20260919.apk`。
包名 `org.nebula.horizon.composeai.uireview`，版本 `1.15.2-debug` / 281，Debug 签名。与正式版并存；不要卸载正式版。默认服务器保留 `https://patcher.villainy.top/`；本机社区验收仅管理员在 Debug 中主动开启，不冒充线上数据。

## 包含的累计修改

- R10/R11/R12 对话菜单、气泡操作、界面设置、记忆书与用户/管理员入口分离；保留透明顶部栏、隐藏名称及用户指定删除项。
- Tavo 对应的角色核心编辑、角色列表与高级定义/选择器；小黑盒对应的社区独立页面、原有“我的”的信息组织。探索卡图透明层与 ID/标签位置保留。
- 管理后台多节点/100+ 模型多选与批量预设、计价；仅改勾选字段、取消不提交、保存失败保留草稿；运行时与宿主均保留分组、取消选择不改模型。
- R13 清除旧全局 CSS 对新布局的覆盖；设置子页面不再显示钱包和首页底栏；手机作品编辑全屏、底部操作固定；关闭充值时正确禁用兑换；合并文件流程分步展开；失败与空状态区分。
- Android 35 键盘避让修复。旧版截图证实 IME 覆盖输入栏，并非没有键盘；现在原生根视图处理 IME/systemBars 的并集。
- 草稿恢复后才开放编辑，更多消息按钮不再闪现；社区“本机验收”提示不会错误显示在联网角色编辑页。

## 实际命令与结果

| 命令 | 结果 / 证据 |
| --- | --- |
| `gradlew.bat testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview -PHOMER_DEBUG_VERSION_CODE=281` | 构建/单测/lint；38 项单测无失败，具体 XML 位于 `android-app/app/build/test-results/testDebugUnitTest` |
| `py -3.13 tools/verify_apk_assets.py` | 1153 项资源；147 个前端文件缺失 0；运行时库 1902 KB |
| `py -3.13 tools/verify_reference_r12.py` | 393×762、360×780、1440×900；核心矩形误差≤3逻辑像素、导入、角色搜索筛选、取消删除、版本弹窗、工坊入口 |
| `py -3.13 tools/verify_models_r12.py` | 360/1440：120 模型、3 组，混合批量修改、取消、负价阻止、保存失败保留、123 公共模型 |
| `py -3.13 tools/verify_runtime_models_r12.py` | 390/1440：真实 iframe→宿主 123 模型、3 组，无管理密钥/地址字段 |
| `py -3.13 tools/test_model_catalog_r12.py` | 4 项服务端目录隔离测试 |
| `py -3.13 tools/verify_chat_runtime.py` | 390×844/1440×900：长按、编辑、隐藏、折叠、回溯、多选、模型/Mod/记忆书、取消/保存、对比度 |
| `py -3.13 tools/verify_community_r7.py` | 390×844、360×800、1440×900：8独立页面、草稿/媒体/发布/评论/收藏/返回/权限，模拟 API 无外部写入 |
| `py -3.13 tools/verify_ux_r11.py` | 普通用户/管理员入口、纯净区搜索、历史摘要、文件导入、农场积分一致性 |
| `py -3.13 tools/verify_delivery_r13.py` | 360/393/1440：12设置/资源/业务页面、暗色设置、全屏资源编辑、禁用状态、失败重试、合并导出；无横向溢出和脚本错误 |
| `py -3.13 tools/verify_local_audit.py` | 缓存与状态隔离断言通过；合成场景缓存首帧桌面339ms/手机211ms，不代表线上全链路耗时 |
| `HOMER_TEST_DEVICE=emulator-5556 HOMER_CDP_PORT=18224 HOMER_REQUIRE_IME=1 node tools/verify_community_r7_android.cjs`（通过 PowerShell 环境变量设置） | Android35 Pixel6 模拟器，真实键盘/返回/草稿恢复/评论/发布/系统相册及卡包选择取消；无远程写入，原生与WebView日志检查 |

最终结果与截图：`output/delivery-r13`、`output/community-r7/android`、`output/ui-models-r12`、`output/chat-ui-r10`、`output/ux-r11`。

最终 APK 已保存，47,607,734 字节；versionCode 281 实际安装后原生回归通过。评论键盘展开后可用高度约530逻辑像素，编辑器保存按钮底部约515逻辑像素，未被键盘遮挡；返回、相册与卡包文件选择取消通过。最终进程 AndroidRuntime 未发现异常日志。原生测试过程中修正了等待页面数据就绪的断言，不把恢复过程中的空壳当成已加载。

## 边界与未声称完成的事项

- 已取得尺寸基准的核心编辑页做过像素差异核对；全软件所有页面尚无同状态登录参照，不能声明全软件 1:1 像素一致。原有功能映射、自有头像、字体及可读性调整有明确差异，见 `TAVO_150_R12_SPEC.md`。
- 模型分组正式名称需要维护者部署 `server-patches/model-catalog/integration.patch`；旧接口仍可按既有 preset_id 分组，不因安装 APK 自动改变生产服务器。
- 社区新接口是否已在实际服务器部署须按服务器状态判定；本机验收仅覆盖本机交互，分享/赛事投票不伪装为线上成功。
- 本轮未发起收费模型生成、真实充值、生产模型保存、真实帖子发布；API 写流程在合成数据中验收。设备为模拟器，不宣称已覆盖所有实体手机。
- Web补丁顺序 R9→R10→R11→R12→`20260919-ui-r13-delivery.patch`；使用临时 Git index 校验，保留真实暂存区。
