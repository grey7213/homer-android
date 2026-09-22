# R15 导航与会话设置重做验收

状态更新：用户已否定 R15 最终视觉效果。技术验证保留为历史证据，不代表视觉通过；后续按 R16 Apple 风格方向重做，参见 UI_MODELS_R12_PLAN.md。

源码：`C:/CodexWork/homer-community-r9`，前端/运行时仍是 `.web-cache/tree` junction；没有提交、推送或部署生产。

## 要求与实际变化

用户最新标准是“风格相仿”，不是像素一致。中间两版截图被用户否定，不能将它们记成视觉验收通过。本文件记录后续重做和技术验证，不代替用户对最终设计的认可。

- 五页主导航由独立组件统一控制，移除 product-design 的冲突规则；保持五入口与粉色选中项，暗色使用对应可读颜色。隐藏子页导航的行为不变。
- 社区频道取消整个按钮的粉色方块，选中只体现在图标和文字；键盘焦点与选中状态分离。
- 模型、Mod、外观、长记忆为完整设置页：顶部返回与标题、独立滚动内容、底部主操作。删除旧模型弹窗样式，而非保留多套规则竞争。
- 模型参数归为同一组，重置降为次要动作；缓存对话与完整运行时共用控件样式。返回取消后不残留未保存参数；模型目录分组未改。
- Mod 默认为说明+开关列表，仅进入“调整顺序”才显示上移/下移；获取更多 Mod 为独立入口，底部仅取消/保存。取消恢复原选择及顺序，未知/失败状态仍禁保存。
- 长记忆分为整理、保存设置、高级设置；最近/全部/自定义范围合为分段选择，自定义才出现起止输入。保留插件原始生成/整合/设置事件，不模拟生成成功、不开放角色世界书正文。
- 外观仍按账号+会话保存，取消恢复；用户原有配色、角色卡自有 HTML、透明对话顶栏及已删除的入口均不恢复。

## 验证证据

- `py -3.13 tools/verify_navigation_r15.py`：360×800、393×852、1440×900，五页浅/深色样式一致，频道无矩形底，页面异常/失败请求为 0。`output/ui-r15/navigation.json`。
- `py -3.13 tools/verify_chat_runtime.py`：390×844、1440×900，实际隔离运行时；完整设置页边界，模型/Mod 取消重开、嵌套模型选择返回、真实记忆范围标记、分区切换、外观保存取消及原聊天回归通过。`output/ui-rework-r2/runtime/`。
- `py -3.13 tools/verify_loading_r14.py`：Mod 慢请求不挡聊天、关闭不重弹、等待禁保存、记忆取消后不迟弹通过。
- `py -3.13 tools/verify_community_r7.py`：三个尺寸八个页面；本机数据不远程写入、普通用户与正式包不能开启本机验收通过。
- Gradle：`testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview -PHOMER_DEBUG_VERSION_CODE=286`；38 单测无失败，lint/构建通过。
- `py -3.13 tools/verify_apk_assets.py`：1157 清单项，150 前端文件，缺失 0。
- Android 35：`HOMER_TEST_DEVICE=emulator-5556 HOMER_CDP_PORT=18224 HOMER_REQUIRE_IME=1 node tools/verify_community_r7_android.cjs`，检查原生返回、真实键盘/文件选择、五页导航、缓存模型设置的保存区边界。最终结果见 `output/community-r7/android/results.json`。

## 产物与边界

验收包：`D:/网站/惑梦-界面重做R15-286-debug-20260919.apk`。

`org.nebula.horizon.composeai.uireview`，versionCode 286，`1.15.2-debug`；沿用现有服务器地址。Debug 签名用于更新同签名验收包，不覆盖正式签名版。

`web-patches/20260919-ui-r15-navigation-settings.patch` 接在 R9→R10→R11→R12→R13→R14 后；临时索引应用检查通过，真实 web 暂存区保持 62 文件、1103+/422-。本轮没有服务端变更。

限制：没有在用户的物理手机上验收；Android 测的是缓存设置和原生容器，完整长记忆/Mod 业务在浏览器隔离运行时测试，未用生产账号调用付费生成。技术检查通过不等于用户已认可视觉设计，不宣称 Tavo 像素一致。
