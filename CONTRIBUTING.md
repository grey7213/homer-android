# 贡献指南

这份文档写给改惑梦 Android 客户端的人。按顺序做就行，不需要先理解整个项目。

一句话说清分工：**原生壳的代码提交进这个仓库，web 端的改动导成补丁一起提交，
编好的 APK 传到另一个仓库的 Releases。** 下面逐条展开。

---

## 一、准备环境（只做一次）

| 要什么 | 版本 | 怎么确认 |
| --- | --- | --- |
| JDK | 17 以上 | `java -version`；用 Android Studio 自带的 jbr 最省事 |
| Android SDK | Platform 35、Build Tools 35 以上 | Android Studio 的 SDK Manager 里勾 |
| Node | 20 以上 | `node -v` |
| Python | 3.10 以上 | `python --version` |
| Git | 任意近版 | `git --version` |

两个环境变量必须设好，Gradle 和脚本都靠它们找工具链：

```powershell
setx JAVA_HOME "E:\Android\AndroidStudio\jbr"
setx ANDROID_HOME "E:\Android\Sdk"
```

设完重开终端。留够 1.5 GB 磁盘。

**路径必须全英文。** aapt 和 apksigner 读不了中文路径 —— 别把仓库放在
`E:\我的项目\` 这种目录下，构建会以看不懂的报错失败。

---

## 二、拉代码并装配工作区

```powershell
git clone https://github.com/grey7213/homer-android.git
cd homer-android
python tools/bootstrap.py
```

`bootstrap.py` 做四件事，第一次跑约 5-10 分钟：

1. 体检环境，缺什么直接告诉你
2. 按 `web-base.json` pin 的 commit 检出 web 基线到 `.web-cache/tree`（约 200 MB）
3. 在仓库根建 `frontend/` 和 `sillytavern-runtime/` 两个链接指向那个检出
4. 装 `sillytavern-runtime` 的运行时依赖（webpack，约 320 MB）

跑完 `frontend/` 和 `sillytavern-runtime/` 会出现在仓库根。**它们是链接，不是仓库内容** ——
`git status` 看不到它们，因为 `.gitignore` 挡掉了。这是故意的：web 端的真源是
`web-base` 分支，本仓库只 pin 一个 commit。两边各存一份必然出现「你改了 A，
维护者改了 B，谁覆盖谁」的静默回退，这个项目已经为此返工过三次。

想先只看看环境够不够：`python tools/bootstrap.py --check`（不动任何文件）。

---

## 三、构建

```powershell
cd android-app
.\gradlew.bat testDebugUnitTest assembleDebug
```

首次约 3-5 分钟（要下 Gradle 8.9 和 AGP）。产物：

```
android-app/app/build/outputs/apk/debug/app-debug.apk
```

装到手机或模拟器：`adb install -r app-debug.apk`。debug 包的 applicationId 带
`.debug` 后缀，和正式版能共存，不会顶掉你手机上装着的那个。

默认连生产服务器 `https://patcher.villainy.top/`。要连自己的后端：

```powershell
.\gradlew.bat assembleDebug -PHOMER_DEBUG_SERVER_BASE_URL=http://192.168.1.20:8081/
```

debug 构建允许回环和内网地址，正式构建强制 HTTPS。换网络后通常要重新构建。

---

## 四、改代码

### 4.1 改原生壳（Java / Gradle / Android 资源）

正常改 `android-app/` 下的文件，正常 commit。这部分在版本控制内，没有特殊步骤。

```
android-app/app/src/main/java/org/nebula/horizon/composeai/ctf/
  HomerActivity.java        多 WebView 页面常驻、导航、Java 桥装配
  ClientAssetStore.java     本地资源拦截（先补丁槽，再 APK 内置）
  ClientAssetRoutes.java    URL 路径 → asset 路径的映射
  HomerCacheDatabase.java   SQLite 会话缓存
  PatchManager.java         签名数据包补丁的 A/B 槽
  SnapshotBridge.java       会话快照的 JS 桥
  LiveBridge.java           实时状态的 JS 桥
  StartupPresentation.java  首屏本地壳
```

**动 Java 桥要特别小心一个坑。** 从 `HomerNative` 上把方法摘下来单独调用必抛异常，
而异常会被 catch 静默吞掉 —— 表现是功能不生效但日志干净。写法必须是
`window.HomerNative.foo(...)`，不能 `const foo = window.HomerNative.foo`。
这个坑让 265 版本的会话缓存从来没真正写进去过，排查花了很久。

改完至少跑一遍：

```powershell
cd android-app
.\gradlew.bat testDebugUnitTest
```

### 4.2 改 web 端（frontend / sillytavern-runtime）

直接改仓库根的 `frontend/` 或 `sillytavern-runtime/` 下的文件，然后导出补丁：

```powershell
python tools/export_web_patch.py --name 修复探索页白屏
```

补丁会写到 `web-patches/20260902-1430-修复探索页白屏.patch`，**把它一起提交进 PR**。

只想看改了什么、先不导文件：`python tools/export_web_patch.py --stat`

补丁头部记着基线 commit，维护者用 `git apply -3` 落地。三方合并的意义是：
基线之后维护者要是也改过同一个文件，改在不同位置会自动合并，撞同一行会明确报冲突。
比整目录覆盖安全 —— 覆盖式交付看不出回退，回退表现为「包里是旧代码」，
而 diff 里什么都看不到。

换机器或重跑过 bootstrap，想把自己的补丁铺回来：

```powershell
python tools/apply_web_patches.py
```

### 4.3 加了新的 web 文件要额外确认

新加的 js/css 模块必须真的进包，否则运行时 `import` 会 404、页面白屏，
而编译和单测全绿。构建完跑：

```powershell
python tools/verify_apk_assets.py
```

它会逐个核对 `frontend/` 下的文件在 APK 里有没有对应条目，同时检查 runtime 的
`lib.js` 不是空的。这条检查有过真实事故：`page-cache.js` 曾经没被同步进去，
探索页和「我的」页直接白屏。

---

## 五、开 PR

```powershell
git checkout -b fix/explore-blank-screen
git add android-app web-patches
git commit -m "修复探索页在无缓存时白屏"
git push -u origin fix/explore-blank-screen
```

到 GitHub 上开 PR 到 `main`。PR 描述按这个结构写，四段都要有：

```markdown
## 问题
探索页在没有本地缓存时白屏，控制台报 page-cache.js 404。

## 影响
全新安装或清过数据的用户打不开探索页。267 版本受影响。

## 修复
frontend/app/assets/js/explore.js 改成动态 import 并加降级分支。
补丁：web-patches/20260902-1430-修复探索页白屏.patch

## 验证
- testDebugUnitTest：17 个全过
- assembleDebug：出包 45.2 MB
- verify_apk_assets.py：通过，109 个前端文件全部在包内
- MuMu 模拟器：清数据后冷启动进探索页正常，无控制台报错
```

**「验证」段必须是真跑过的结果，带真实数字。** 没跑的就写没跑。
写了没跑的验证比不写更糟 —— 我会按它的结论决定要不要复核。

提交时不要带上：APK / AAB、`local.properties`、`.gradle/`、`build/`、
任何签名文件（`.keystore`、`.jks`、`.pem`、`.key`）。`.gitignore` 已经挡了绝大部分，
但 `git add -A` 之前还是先 `git status` 看一眼。

PR 开好后会自动跑构建校验：装配工作区 → 落地你的 web 补丁 → 单测 → assembleDebug →
校验资源完整性。绿灯不代表功能对，但能挡掉编译不过、补丁对不上基线、新文件没进包
这三类返工。CI 会把 debug APK 作为 artifact 传上来，保留 14 天，可以直接下载装机验。

---

## 六、交成品 APK

编好的包传到 [homer-android-apk](https://github.com/grey7213/homer-android-apk) 的 Releases，
**不要提交进任何仓库的 git 历史** —— 一个包 40 MB，进了历史就永久留在里面，删不掉，
克隆会越来越慢。

网页上传：Releases → Draft a new release，tag 填 `debug-20260902-探索页修复`，
勾上 pre-release，把 APK 拖进附件区。

命令行（装了 gh CLI）：

```powershell
gh release create debug-20260902-explore-fix `
  --repo grey7213/homer-android-apk `
  --title "debug 探索页修复" --notes "对应 PR #12，仅供验收，未正式签名" `
  --prerelease `
  android-app/app/build/outputs/apk/debug/app-debug.apk
```

Release 说明里写清三件事：对应哪个 PR、用什么签名（debug 还是正式）、验过什么。

**你手上不会有正式发布私钥，也不需要有。** 正式签名由维护者完成。
debug 签名的包装不上正式版，也顶不掉用户已装的应用，用来验收正好。

---

## 七、自查清单

提 PR 前对一遍：

- [ ] `testDebugUnitTest` 全过
- [ ] `assembleDebug` 出包
- [ ] 改动或新增过 web 文件 → `verify_apk_assets.py` 通过
- [ ] web 端有改动 → 补丁已导出并 `git add`
- [ ] 装到真机或模拟器冷启动过，没崩
- [ ] 动过页面导航 → 探索 → 我的 → 探索 往返正常，旧页面保持滚动位置
- [ ] 动过对话 → 发送、切历史、AI 气泡靠左用户气泡靠右都正常
- [ ] 桌面和 390×844 手机视口都看过，没有横向溢出，控制台没有新报错
- [ ] 没提交 APK、签名文件、`local.properties`
- [ ] PR 描述有问题 / 影响 / 修复 / 验证四段，验证是真跑的

---

## 八、卡住了看这里

**`缺少 web 端：... 不存在`**
Gradle 找不到 `frontend/` 或 `sillytavern-runtime/`。在仓库根跑 `python tools/bootstrap.py`。

**`sillytavern-runtime 缺 node_modules/webpack`**
node 依赖没装。跑 `python tools/bootstrap.py`。要强制重装：删掉
`.web-cache/tree/sillytavern-runtime/node_modules/.homer-bootstrap` 再跑。

**`web-base 现在是 xxx，但 web-base.json pin 的是 yyy`**
基线动了而你手上的 pin 是旧的。`git pull` 拿最新的 `web-base.json` 再跑 bootstrap。

**`frontend/ 已存在且不是链接`**
那个位置有个真目录而不是 bootstrap 建的链接。确认里面没有你自己的东西，删掉再跑 bootstrap。

**`SDK location not found`**
`ANDROID_HOME` 没设，或者 `android-app/local.properties` 里的 `sdk.dir` 不对。
bootstrap 会按 `ANDROID_HOME` 自动生成这个文件。

**构建报一堆看不懂的路径错误**
检查仓库路径里有没有中文或空格。aapt / apksigner 读不了中文路径。

**`export_web_patch.py` 说没有改动**
你可能只改了原生壳。那种情况直接提交 `android-app/` 就行，不需要补丁。

**改了 web 文件但 APK 里还是旧的**
`syncHomerClientAssets` 有缓存。`.\gradlew.bat clean assembleDebug` 重来一遍，
再用 `verify_apk_assets.py` 确认。
