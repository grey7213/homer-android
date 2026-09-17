# 社区 R7：独立页面验收

## 安装包与范围

- APK：`D:\网站\惑梦-社区独立页面R7-debug-20260917.apk`
- 包名：`org.nebula.horizon.composeai.uireview`；debug 签名，可与正式版共存，可覆盖此前同签名的 UI 验收版。
- 源码：`D:\网站\homer-android-main`。未提交 Git、未部署服务器、未替换正式版。
- 管理员登录后通过底部“社区·验收”进入。本机模式常驻“本机验收 · 不上传”标识；帖子、评论、图片、举报和管理操作保存在本机，不写线上社区。验收选项内可管理或清空这些本机数据。
- 普通账号和正式构建不能启用本机模式；线上社区仍沿用服务端开放开关。

## 本轮变化

| 页面 | 路径 | 验收重点 |
| --- | --- | --- |
| 社区首页 | `/app/community.html` | 紧凑话题、关注/推荐、排序、搜索/消息入口、发帖入口 |
| 搜索 | `/app/community-search.html` | 帖子/用户/话题分类、最近搜索、结果、空态、返回保留查询 |
| 帖子详情 | `/app/community-post.html?id=…` | 完整独立页面，不露底页；正文、关注、点赞收藏、评论、按需附件 |
| 发布/编辑 | `/app/community-compose.html` | 独立编辑器、自动保存、图片恢复、标签分隔、发布禁用/失败保留 |
| 我的动态 | `/app/community-activity.html` | 自己的帖子、评论和草稿入口；从现有“我的”接入，不另建账号中心 |
| 我的收藏 | `/app/favorites.html?tab=community` | 原收藏页增加“社区帖子”分类，角色卡收藏不搬家 |
| 作者主页 | `/app/community-profile.html?user=…` | 作者信息、帖子/评论、关注/拉黑 |
| 社区消息 | `/app/community-messages.html` | 消息分类、选中状态、未读和空态 |

详情、搜索、写帖、动态、收藏和作者主页均有独立 URL 和返回历史，不再以首页上的大型弹窗承担主流程。举报、确认、提及等次级操作仍使用操作面板。角色卡 ID 解析和原有社区接口继续复用。

修复了详情页未归一化 `locked` 缺省字段导致评论框误禁用的问题；话题标签空格分隔、拒绝协议退出社区、错误重试保留当前分类也纳入回归。

## 已执行验证

1. `py -3.13 -m unittest discover -s tools -p 'test_community*.py'`：60 项通过；隔离数据库，包含权限、内容状态、互动及媒体行为。
2. `py -3.13 tools/verify_community_r7.py`：390×844、360×800、1440×900 通过；8 页面全链路、评论、图片草稿重开、发布编辑、收藏取消、搜索返回、列表位置恢复、删除取消和删除后空态；普通账号/非 debug 禁止本机访问。无页面异常、无失败请求、无线上写请求。
3. `gradlew.bat --no-daemon testDebugUnitTest lintDebug assembleDebug -PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview`：通过。
4. `node tools/verify_community_r7_android.cjs`：已安装 APK 中的原生 debug 能力、独立页面切换、Android 返回、草稿恢复、发布/评论、系统媒体选择器取消、本机管理通过；使用合成账号，结束后仅清理该测试账号数据。
5. `py -3.13 tools/verify_apk_assets.py --apk C:\CodexWork\homer-ui-redesign\android-app\app\build\outputs\apk\debug\app-debug.apk`：1145 项资源清单，139 个前端文件，缺失 0；新页面及模块全部入包。

浏览器证据：`output/community-r7/results.json` 和同目录各页面截图。设备证据：`output/community-r7/android/`。截图已人工检查标题层级、正文对比、整页宽度、输入区和底部导航；修复了空消息页的 `hidden` 被布局样式覆盖而露出“更多消息”的问题，并增加浏览器和设备断言。

## 明确未通过实测的部分

- MuMu 的输入法报告已打开，但未实际显示可见键盘，也未压缩页面视口。因此不能把输入法状态位算作真机键盘遮挡验收；此项需真实手机复核。代码保留 visualViewport 的输入栏位置适配，浏览器窄屏和设备正常视口几何检查通过。
- 小黑盒凭据提交后仍停留在登录页；已请求用户手动完成登录，尚未收到完成回复。本轮参考既有可见信息流和用户截图，按行为规格重新实现，没有完成小黑盒登录后各页面的像素对照，也不宣称 1:1 复刻。
- 本机验收不能验证真实社区服务器部署、真实多人同步、线上分享或赛事投票；本轮没有修改或发布真实社区服务器。

## 交接

`web-patches` 根目录只保留最新 R7 累计补丁；旧 R6 存入 `archive`，不能叠加应用多个累计补丁。正式发布仍需维护人员审查补丁并按仓库流程构建签名，不应使用此 debug APK 替代正式更新。
