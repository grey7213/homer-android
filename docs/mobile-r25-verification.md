# R25 本地验收记录

## 产物与来源

- 工作区：`C:/CodexWork/homer-community-r9`，分支 `fix/mobile-workshop-performance-r25`，主线基点 `2ca06d7`。
- APK：`android-app/app/build/outputs/apk/debug/app-debug.apk`；版本码 **308**，debug 独立包，不覆盖正式签名软件。
- SHA-256：`50C4F77F8C1ED3003ED1CD90EEF041B82990F82850EFF5E60464E73EF311BC1C`。
- 内置资源 1187 项，178 个前端文件无缺失；前端与运行时所有受打包规则管理的源文件逐字节核对通过。
- 完整 Web 补丁从锁定 pin 导出，包含此前已交付改动与本轮改动；102 个文件。不是只导出本轮增量后丢掉历史功能。
- 本轮没有 Git commit、push、PR 或生产部署。

## 验证命令

```powershell
node --test tools/tests/mobile-r25-resources.test.mjs tools/tests/mobile-r25-runtime.test.cjs
py -3.13 tools/tests/test_mobile_r25_host.py
py -3.13 tools/test_export_web_patch.py
py -3.13 tools/tests/mobile_r25_e2e.py --credentials <本机凭据文件> --output output/mobile-r25/e2e-final
# Android 工作目录 android-app，JDK 21 / SDK 35
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug `
  '-PHOMER_DEBUG_SERVER_BASE_URL=http://172.24.5.154:8086/' `
  '-PHOMER_DEBUG_APPLICATION_SUFFIX=.uireview' '-PHOMER_DEBUG_VERSION_CODE=308'
py -3.13 tools/verify_apk_assets.py
# ADB 将当前 WebView 调试端口转发到 9335；凭据只通过本地路径环境变量提供
node tools/tests/mobile-r25-android.cjs
```

结果：Node 7/7、服务端 3/3、导出工具 2/2；Gradle 成功，lint 0 errors / 5 既有 warnings。浏览器两种视口流程通过，脚本异常为 0。

### 已测流程

- 创作角色卡文件导入→开启聊天→回到历史→重开同一会话，只有一条新会话，角色实际绑定正确，输入框可用。
- 中断历史接口后本账号已有缓存记录仍可见。
- 模型名称不附加原始供应商标识；三个分组可包含相同供应商模型但使用独立选择 ID；公共模型目录不返回密钥/节点私有配置。
- 预设、Mod、正则文件读取、保存、重新打开；预设保留 prompt_order；世界书保留原生条目字段；正则保留禁用、位置与原生参数。
- 非作者无法取得私有资源；闭源公开资源不返回源内容；不靠隐藏按钮实现后端鉴权。
- 正则预览使用 Worker，700ms 超时终止；HTML 在无脚本、无外网权限的独立 iframe 中展示。
- 模拟器 APK 的真实 WebView Worker、资源保存、深浅主题、长记忆打开、主导航持久页面与聊天复用通过。未运行付费模型生成。
- 浏览器日志中的测试账户默认头像 404 会回退到内置头像；页面离开时模型状态请求取消为预期行为；历史断网测试的失败请求为主动注入。

## 性能边界（不能标成全部秒开）

Android API 35 模拟器最新样本：

| 场景 | 时间 |
|---|---:|
| 首次进入各主页面（包括完整 load 等待） | 794–2352ms |
| 同一进程内返回已打开主页面 | 93–645ms |
| 已预热运行时绑定全新卡 | 3633ms |
| 返回已打开的对话 | 150ms |
| 当前真实会话打开长记忆首页 | 232ms |

先前同环境新卡样本 2309–2820ms；独立完整冷启动样本约 7.2s。测试主机负载、扩展、卡大小和网络影响明显。用户第一项仍有未解决的冷启动等待，不能用热返回或本地预览替代完整可交互计时。

## 第六项：只解释

案例1 PNG 中启用的正则把 `LOADING...` 转成 HTML 使用说明，说明里就有截图中“必备前置插件”等原文。HTML 被包在代码围栏中，需要酒馆助手接管渲染。部分被显示成源码意味着该段没有被正确接管或源码未被隐藏，但不能凭截图进一步确定用户那一版的原因。

本地同卡已实际导入：JS-Slash-Runner 已加载，产生 iframe，原 `<pre>` 被隐藏。故不能把问题简单归为“没安装插件”，也不能声称复现并修复了用户安装版本的问题。本轮未改动案例卡内容，没有添加单卡特例。

## 交接条件

测试服务在这台电脑 `172.24.5.154:8086`，手机需能访问该局域网地址。数据使用本机隔离副本，正式服账号/积分/角色数据未更改。若服务器停机或 IP 改变，该测试包不能当正式版联网使用。

正式更新需要维护者同时应用服务端补丁并发布本轮完整客户端资源；单独更新 APK 无法让旧服务端返回模型分组或接收新增正则资源。
