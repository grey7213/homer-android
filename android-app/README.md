# 惑梦 Android 客户端

该工程不是只打开网页的最小壳。构建时会把惑梦前端、固定的对话运行时及已启用的角色卡扩展编入 APK，并包含本地会话快照、SQLite 缓存、后台完整 Web 对话预热、安全导航、文件选择、音视频权限和签名 A/B 资源补丁。静态页面、运行时脚本和扩展优先从 APK/补丁槽读取；登录、账号、云端会话、积分、模型目录、模型 URL 和 API Key 仍由惑梦后端统一管理。

当前随包启用 `ST-Prompt-Template`、`JS-Slash-Runner` 和 `SillyTavern-MemoryBooks`。按产品要求，`Yuzi Phone` 不会进入客户端资源包，也不会执行。

## 构建

要求 JDK 21、Android SDK 35 和 Build Tools 35。首次在本机创建 `local.properties`：

```properties
sdk.dir=D\:\\Android\\Sdk
```

调试构建：

```powershell
.\gradlew.bat testDebugUnitTest assembleDebug `
  -PHOMER_DEBUG_SERVER_BASE_URL=http://127.0.0.1:8080/
adb reverse tcp:8080 tcp:8080
```

`HOMER_DEBUG_SERVER_BASE_URL` 允许回环地址，或显式用于同一局域网测试的 RFC1918 私有地址（例如 `http://192.168.1.20:8081/`）；正式构建不读取该地址，仍强制使用 HTTPS。局域网模式要求电脑上的调试代理绑定该地址，手机与电脑连接同一 Wi-Fi，且换网后通常需要重新构建 APK。

局域网代理示例（代理转发到本机 `8000` 后端和 `8091` 对话运行时）：

```powershell
python ..\tools\offline_dev_proxy.py `
  --host 192.168.1.20 --port 8081 --allow-network
```

正式域名和补丁公钥通过 Gradle 属性注入：

```powershell
.\gradlew.bat assembleRelease `
  -PHOMER_SERVER_BASE_URL=https://your-domain.example/ `
  -PHOMER_PATCH_PUBLIC_KEY_B64=<RSA_PUBLIC_DER_BASE64>
```

`HOMER_SERVER_BASE_URL` 必须是以 `/` 结尾的 HTTPS 地址。模型 API Key、数据库密码和后台凭据不得作为 Gradle 属性或客户端资源传入。

## 发布签名

- `applicationId` 保持 `org.nebula.horizon.composeai`，正式版可延续现有包名。
- 当前主项目不包含原 APK 发布私钥；本地产物使用 Android 调试证书，不能覆盖用户已安装的正式版。
- 技术人员必须在安全构建环境中使用原发布证书签名。若原证书已经遗失，只能更换包名作为新应用发布。
- 发布私钥、口令、补丁私钥都不得放入该目录、Git 或服务器 Web 根目录。

## 服务器职责

1. HTTPS 证书必须覆盖正式域名且证书链完整。
2. `/app/`、`/console/api/web/*` 和 `/module/dialogue/*` 保持同源。
3. `runtime.dialogue_url` 返回相对 `/module/dialogue/` 或同源 HTTPS URL。
4. 用户登录、会话归属、积分校验、扣费、模型映射和上游 API Key 全部留在服务器。
5. APK 只展示后台上架的模型，不提供用户填写 Base URL 或 Key 的入口。

当前 `https://patcher.villainy.top/` 在 2026-08-17 实测证书主机名不匹配，Android 会正确拒绝连接；上线前必须由技术人员修复，不能在客户端绕过 TLS 校验。

## 数据包补丁

私钥必须生成在项目目录之外：

```powershell
python ..\tools\generate_android_patch_keys.py `
  --private-key D:\secure\homer-patch-private.pem `
  --public-key-b64 D:\secure\homer-patch-public.b64
```

构建补丁：

```powershell
python ..\tools\build_android_patch.py `
  --source .\app\build\generated\homerClientAssets `
  --version 2026.08.17.1 `
  --min-app-version 262 `
  --base-url https://your-domain.example/updates/android/ `
  --private-key D:\secure\homer-patch-private.pem `
  --output D:\release\android-update
```

把 `manifest.json` 和 ZIP 放到 `/updates/android/`。客户端会验证 RSA-SHA256 签名、ZIP SHA-256、逐文件哈希和路径，再写入非活动槽。新槽首次加载失败时，下次启动自动回到上一槽。

## 不能用数据包完成的更新

Manifest、Android 权限、原生 Java、SQLite schema、原生桥和系统组件发生变化时必须发布新 APK。普通 HTML/CSS/JS、对话运行时前端、兼容规则和扩展资源可通过签名数据包更新。补丁源必须使用构建生成的 `app/build/generated/homerClientAssets`，这样 `client/web` 与 `client/runtime` 才会一起进入补丁。
