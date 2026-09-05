# homer-android

惑梦 Android 客户端的原生壳源码，以及把它装配成可构建工作区的脚本。

这不是一个只加载网页的最小壳：构建时会把惑梦前端、对话运行时和已启用的角色卡扩展
编入 APK，另有本地会话快照、SQLite 缓存、后台完整 Web 对话预热、多 WebView 页面常驻、
安全导航和签名数据包补丁。登录、账号、云端会话、积分、模型目录和 API Key 全部留在服务端。

1.15.0 起支持应用内检查、下载和安装 APK 更新，登录页和「我的」提供手动检查入口。
旧版用户先覆盖安装本版一次，之后可直接在软件内更新，安装由 Android 系统确认。

## 仓库分工

| 放什么 | 在哪 |
| --- | --- |
| 原生壳源码（Java / Gradle / 资源） | 本仓库 `android-app/` |
| web 端基线（`frontend/`、`sillytavern-runtime/`） | 本仓库的孤立分支 `web-base`，由 bootstrap 检出 |
| web 端改动 | 本仓库 `web-patches/*.patch`，由脚本导出 |
| 成品 APK | [homer-android-apk](https://github.com/grey7213/homer-android-apk) 的 Releases |

`main` 分支只有 1.8 MB —— web 端那两棵树（合计约 140 MB）不在版本控制内，
由 `tools/bootstrap.py` 按 `web-base.json` pin 的 commit 装配到仓库根。
Gradle 的 `syncHomerClientAssets` 从 `android-app` 的父目录读它们。

## 快速开始

```powershell
git clone https://github.com/grey7213/homer-android.git
cd homer-android
python tools/bootstrap.py          # 装配 web 基线 + node 依赖，首次约 5-10 分钟
cd android-app
.\gradlew.bat testDebugUnitTest assembleDebug
```

产物在 `android-app/app/build/outputs/apk/debug/app-debug.apk`。

完整流程、改 web 端的方式、提交与验收要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 提交改动

`main` 有保护规则：必须过 PR，CI 的 `build` 绿灯才能合，force push 和删分支都禁了。

两条路都行 —— fork 后提 PR（任何人，不需要我先做什么），或者找我加 collaborator
后直接在本仓库开分支。发 Release 需要 collaborator 权限。细节见 CONTRIBUTING 第一节。

## 脚本

| 脚本 | 干什么 |
| --- | --- |
| `tools/bootstrap.py` | 装配可构建工作区。`--check` 只体检环境，`--skip-npm` 跳过 node 依赖 |
| `tools/export_web_patch.py` | 把 web 端改动导成对着基线 commit 的 git patch |
| `tools/apply_web_patches.py` | 把 `web-patches/` 的补丁落到 web 检出上（CI 用，换机器时也用） |
| `tools/verify_apk_assets.py` | 校验 APK 里真的带上了前端与运行时资源 |

## 环境要求

- JDK 17 以上（Android Studio 自带的 jbr 就行），`JAVA_HOME` 指向它
- Android SDK 35 + Build Tools 35 以上，`ANDROID_HOME` 指向 SDK 根
- Node 20 以上（`compileHomerDialogueLibraries` 要跑 webpack）
- Python 3.10 以上、Git
- 磁盘约 1.5 GB（web 基线 200 MB + node_modules 320 MB + 构建产物）

## 签名

本仓库不含任何签名材料。`assembleDebug` 用 Android 调试证书，装不上正式版。
正式签名由持有发布私钥的维护者完成 —— 私钥、口令、补丁私钥都不进版本库，
`.gitignore` 已按扩展名挡掉。

## 许可

`android-app/` 与 `tools/` 是本项目自有代码。构建时会编入
[SillyTavern](https://github.com/SillyTavern/SillyTavern) 及其扩展，
那部分按各自的许可（SillyTavern 为 AGPL-3.0）分发，许可文本随
`web-base` 分支一起保留在 `sillytavern-runtime/LICENSE`。
