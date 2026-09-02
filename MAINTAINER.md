# 维护者操作手册

写给我自己。贡献者那边看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 三个仓库的关系

```
grey7213/AIXingYue（公开）           主仓库。web 端真源，我的完整工作区
        │
        │  推 frontend/ + sillytavern-runtime/ 两棵树
        ▼
grey7213/homer-android（私有）        原生壳源码 + 装配脚本
        ├─ main        android-app/、tools/、web-patches/
        └─ web-base    孤立分支，只有那两棵 web 树，供 bootstrap 检出
        │
        │  贡献者编好的包
        ▼
grey7213/homer-android-apk（私有）    只走 Releases，不进 git 历史
```

`android-app/` 的源码此前只存在于 `E:\homer-apk-1140`，不在任何版本控制内。
现在 homer-android 是它的真源，`E:\homer-apk-1140` 退化成我本地的出包工作区。

## 收一个 PR

```powershell
cd E:\homer-android
git fetch origin
git checkout -b pr-12 origin/fix/explore-blank-screen
python tools/bootstrap.py        # 对齐 pin，通常已就位
```

**先看 web 补丁，再看 Java 改动。** 补丁是三方合并落地的，可能和我这边的改动撞车：

```powershell
# 在主仓库工作区试算，不真的改文件
cd E:\酒馆开发
git apply -3 --check --stat "E:\homer-android\web-patches\20260902-1430-修复探索页白屏.patch"
```

`--check` 通过就落地：

```powershell
git apply -3 "E:\homer-android\web-patches\20260902-1430-修复探索页白屏.patch"
git status --short frontend sillytavern-runtime
```

报冲突（`with conflicts` / `UU`）说明基线之后我改过同一位置。文件里会有
`<<<<<<< ours` / `>>>>>>> theirs` 标记，手工合。**不要图省事整目录覆盖** ——
覆盖式合并已经烧过三次，回退表现为「包里是旧代码」，在 diff 里完全看不出来。

Java 改动正常读 diff。重点看：
- 有没有从 `HomerNative` 上摘方法（`const foo = window.HomerNative.foo`），必抛且被吞
- 新加的 web 模块有没有对应的 `verify_apk_assets.py` 通过记录
- 有没有夹带 `local.properties`、APK、签名文件

## 出正式包

补丁落地到主仓库、Java 改动合进 homer-android 之后：

```powershell
# 1. 主仓库的 web 改动同步到本地出包工作区
cd E:\酒馆开发
python tools\sync_apk_build_workspace.py

# 2. 原生壳改动同步过去（homer-android 是真源，方向是 homer-android → 1140）
robocopy E:\homer-android\android-app E:\homer-apk-1140\android-app /MIR /XD .gradle build /XF local.properties

# 3. 构建
cd E:\homer-apk-1140\android-app
.\gradlew.bat testReleaseUnitTest assembleRelease -PHOMER_SERVER_BASE_URL=https://patcher.villainy.top/
```

签名材料在 `E:\homer-apk-1140\_sign\signer.keystore`，alias `zip1repack`，
证书指纹 `429b…f320`。读它要 JDK 17+，build-tools 用 `E:\Android\Sdk\build-tools\36.1.0`。
版本号在 `android-app/app/build.gradle` 的 `versionCode` / `versionName`。

发布走 `python tools\publish_homer_apk.py <签名后的apk>` —— 它会校验 versionCode
必须比线上大、签名指纹必须一致，然后 SFTP 原子上传并重写 `release.json`。
别手改服务器文件。

## 推进 web 基线

我这边 web 端有新改动后，贡献者要能拉到。推 `web-base` 分支：

```powershell
python E:\homer-android\tools\push_web_base.py
```

它从主仓库当前 HEAD 取那两棵树，造一个孤立提交推上去，并更新
`homer-android/web-base.json` 的 pin。之后记得把 `web-base.json` 的改动提交到 `main`，
否则贡献者的 bootstrap 会报「基线动了而 pin 没跟上」。

## 邀请贡献者

两个仓库都是私有，得逐个加。**`write` 权限是发 Release 的最低门槛** ——
`read` 和 `triage` 都只能看已发布的 Release，建不了新的。

```powershell
gh api -X PUT repos/grey7213/homer-android/collaborators/<用户名> -f permission=push
gh api -X PUT repos/grey7213/homer-android-apk/collaborators/<用户名> -f permission=push
```

API 里的 `push` 就是界面上的 Write。给完对方邮箱收到邀请，或直接开
`https://github.com/grey7213/<仓库>/invitations` 接受。没接受之前 clone 报
`Repository not found` —— 私有仓对未授权的人一律显示不存在。

查现状：

```powershell
gh api repos/grey7213/homer-android/collaborators --jq '.[] | "\(.login) \(.role_name)"'
gh api repos/grey7213/homer-android/invitations --jq 'length'   # 待接受的邀请数
```

`write` 能做：推分支、开 PR、合 PR、发 Release、跑 Actions。
不能做：改仓库设置、加删协作者、删仓库。

**分支保护开不了。** 私有仓要 GitHub Pro 才能设 required status checks，
免费额度下 API 直接返回 `Upgrade to GitHub Pro`。也就是说 `write` 权限的人
技术上能直接 push 到 `main`，也能合自己的 PR。靠约定管：CONTRIBUTING 里写明走 PR、
别直推 `main`，我收 PR 时看 CI 绿灯。真需要硬性拦截就得升 Pro 或把仓库转公开。

想临时收紧可以先给 `read`，只让对方 clone 和开 issue，确认靠谱了再提到 `push`。
但 `read` 发不了 Release，那就得他们把 APK 发给我、我来传。

