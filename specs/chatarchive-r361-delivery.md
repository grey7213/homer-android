# R361 交付与上线边界

## 内容

探索页通知紧邻剧情剧场入口，个人中心不重复入口；沿用用户已认可的横屏普通玩法并紧凑化大厅/人物列表。工坊在独立受控 WebView 中打开 https://chatarchivemods.org/，只使用该站自己的登录，不向页面注入 Homer 原生桥或账号。

用户明确选择后才下载 CAPK / 含 CAPK 的 ZIP，核对大小及 SHA-256，原子安装到手机私有目录；取消、损坏或缺空间不替换旧素材或进度。7Z/RAR 当前不支持直接导入，有清晰提示，不宣称所有工坊格式兼容。人物样本与大素材包不进入交付 APK/公开仓库。

人物资源与存档独立。保存修订 UUID 与哈希；重装恢复已确认云备份后，可下载原修订再继续，不能用更新后的角色包静默替换。旧版本下架仍保留剧情。不自动新建会话、自动生成、重放计费请求。

原有基沃托斯素材可本机导入；本次正式构建不配置未经授权的公共素材镜像。无旧素材时默认选择工坊人物，提示先在工坊下载，不承诺未配置的背景下载服务。

## 验证

- Node 累计回归：2106 项，2105 PASS，1 个原有合成性能测试 SKIP，0 FAIL；保留实际会话启动、模型、正则、离线与权限断言。旧 VM 测试接入新增展示状态外设，不更改产品逻辑逃避测试。
- 真实合法工坊 ZIP/CAPK 样本：13,494,935 字节、39 个实际动作；解析器路径/损坏包测试及 Android API35 原生渲染通过。样本只存在私有 QA 目录及可选测试 APK，不进主 APK。
- 三尺寸明暗六场景：实际工坊素材 + 合成身份/模型 + 实际 HTTP/SQLite 接口，完整进度/分支恢复，缺素材提示，恢复没有导卡/新会话/生成。脚本/HTTP 错误 0。
- 已认可 R360 普通玩法六场景重测：人物、私聊、故事群、邀请/约会、事件/回看、撤回备份、本机重开、无导演均通过；真实素材来自用户本机资料，模型为合成，非原版 1.2.6 完整等价证明。
- 整体普通聊天运行时：390×844、1440×900 各 1101 条完整消息，离线重开、往返切换、正则保留、失败生成不丢消息、不重放请求通过。独立全页面初始化约 5–9 秒，不将此检查冒称 Android 秒开测速。

## 最终本地交付

- APK：`D:/网站/验收包/ChatArchive-R361/惑梦-剧情剧场-工坊-R361-debug.apk`，74,516,624 字节（71.1 MiB）。SHA-256：`9796BF5DEDC6FFF4F570EC61B70CE1A469018AFFF711806B6ED8B135840E53AC`。
- 包名 `org.nebula.horizon.composeai.uireview`，versionCode 361 / `1.18.8-debug`，主接口 `https://patcher.villainy.top/`；旧 R360 验收包和 R361 证书一致，API35 模拟器覆盖安装成功，不卸载或清数据。独立于正式版安装。
- 从新原生 checkout + 固定 web commit `02069118baa83354f3e01a6d0021562111211373` 顺序应用九份补丁重建；2252 个规范化源码文件与本地一致，0 不一致。仅复用锁文件对应的工具依赖，不复用本地修改源码。
- 干净 checkout 执行 `node --experimental-vm-modules --test --test-concurrency=1 tools/tests/*.test.mjs tools/tests/*.test.cjs`：2105 PASS / 1 SKIP / 0 FAIL；CI 的七组 Python 检查合计 78 PASS（包含新增后端顺序组合检查）。
- 干净 checkout 执行 `gradlew.bat --no-daemon testDebugUnitTest lintDebug assembleDebug`（仅指定 `.uireview` 与正式 HTTPS）：58 秒 SUCCESS；Java 107 项、106 PASS / 1 可选真实素材测试 SKIP / 0 FAIL，lint 0 Error / 10 Warning。此前启用私有样本的原生单元测试 107 PASS。
- 最终同配置测试 APK 的 API35 原生测试：方向/保留文档生命周期两项、真实合法工坊包安装/39动作/私聊键盘渲染一项，3/3 PASS，17.99 秒。测试 APK 的合成身份/模型与私有样本不进入主 APK；主 APK 内 CAPK/HCAP/完整骨骼/启动人物包均为 0。
- `python tools/verify_apk_assets.py`：1849 资源条目、613 前端文件、缺失 0；原始资源字节及兼容编译源码/产物双哈希一致。最终复制到交付目录后 SHA-256 再次一致。
- 干净 checkout 实际发现并修正 Windows 换行使服务端清单 SHA 不一致的问题，固定四个交接模块为 LF；没有把精确字节验证改成忽略损坏的比较。
- 本地证据：`output/chatarchive-r361/clean-{node,build,native}-final.log`、`clean-apk-assets-final.log`、`clean-native-evidence/`、`browser/results.json`、`r360-regression.log`、`ordinary-runtime.log`。Android 内完整第三方登录→下载链仍需手机验收，非本次原生媒体渲染测试覆盖。

## 必须分开处理

1. Android 原生源码和本次增量 Web 补丁随 PR 提交。Web 补丁按文件名顺序应用在固定基线，不拿整目录覆盖主工程。
2. 服务端增量在 `server-patches/archive-r361/`，维护者必须单独部署并验收；PR/APK 不是部署。
   先 R354 普通聊天存档增量再 R361 剧场增量；真实本机提供者副本上的两份 `git apply --check`/应用和编译均通过，规范化结果 SHA 与清单一致。仅副本验证，不修改现有服务或数据库。
3. 本地验收 APK 连接现有正式 HTTPS 账号/模型接口，但剧场云备份新接口尚未部署。界面如实提示勿卸载；不能宣称生产重装恢复已测。
4. 工坊正常登录下载在用户自己的浏览器会话完成；Android 原生解析/安装/渲染已测，Android 工坊登录到下载的真实完整链路仍需手机验收。

不发布正式 APK、不覆盖官网或服务器；不读取/复用真实玩家保存，不记录账号密码，不上传角色媒体。

## 源码提交

分支 `feat/chatarchive-workshop-r361` 已合并上游 `main`（`3eeeeb7`）的既有个人备份功能，保留 R354 本机主存档保护及本次完整剧场增量；源码 PR 与正式部署分开。未部署服务端时请勿卸载应用验证重装恢复。
