# 维护者操作手册

写给我自己。贡献者那边看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 三个仓库的关系

```
grey7213/AIXingYue（公开）           主仓库。web 端真源，我的完整工作区
        │
        │  推 frontend/ + sillytavern-runtime/ 两棵树
        ▼
grey7213/homer-android（公开）        原生壳源码 + 装配脚本
        ├─ main        android-app/、tools/、web-patches/
        └─ web-base    孤立分支，只有那两棵 web 树，供 bootstrap 检出
        │
        │  贡献者编好的包
        ▼
grey7213/homer-android-apk（公开）    只走 Releases，不进 git 历史
```

`android-app/` 的源码此前只存在于 `E:\homer-apk-1140`，不在任何版本控制内。
现在 homer-android 是它的真源，`E:\homer-apk-1140` 退化成我本地的出包工作区。

## main 的保护规则

仓库转公开后开了 ruleset `main 保护`（id `22080138`）：

| 规则 | 效果 |
| --- | --- |
| `pull_request` | 不能直推 `main`，必须开 PR |
| `required_status_checks` = `build` | CI 的 build job 绿灯才能合 |
| `non_fast_forward` | 禁 force push |
| `deletion` | 禁删 `main` |

`strict` 打开了，所以 PR 分支必须先跟上 `main` 才让合 —— 落后的分支
GitHub 会提示 Update branch。

**bypass 给了 admin（`RepositoryRole` id 5）**，我推 `web-base.json` 的 pin
不必绕一圈开 PR。实测过：撤掉 bypass 时我自己直推也会被
`push declined due to repository rule violations` 挡下，加回来才通。
CI 上报的 check 名确认是 `build`，和规则里写的一致 —— 名字对不上会导致
所有 PR 永远卡在「等待 build」。

改规则：

```powershell
gh api repos/grey7213/homer-android/rulesets/22080138           # 看现状
gh api -X PUT repos/grey7213/homer-android/rulesets/22080138 -f enforcement=disabled  # 临时关掉
```

## 每次发布上线怎么合

这是最常走的一条路。前提是 PR 的 CI 已经绿了：

```powershell
gh pr checks 12                    # 确认 build 通过
gh pr merge 12 --squash --delete-branch
```

`--squash` 把贡献者的多个提交压成一个，主线历史干净。合完拉下来出包：

```powershell
cd E:\homer-android
git checkout main && git pull
```

然后走下面的「出正式包」。web 补丁要先落地到主仓库 —— 那部分不在这个仓库的
merge 范围内，见「收一个 PR」。

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

签名材料在 `E:\homer-apk-1140\_sign\`（本机，不在版本库）。alias、口令、
证书指纹见 `AGENTS.md` 的构建段 —— **仓库已公开，这些不写进这个文件**。
读 keystore 要 JDK 17+，build-tools 用 `E:\Android\Sdk\build-tools\36.1.0`。
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

**基线推进之后，`web-patches/` 里已经落地的补丁必须一起删掉。** 那些补丁的改动
已经包含在新基线里，留着会让 `apply_web_patches.py --strict` 报「基线不符」，
之后每个 PR 都红灯。删补丁和提交 pin 放同一个提交里：

```powershell
cd E:\homer-android
git rm web-patches\<已落地的补丁>.patch
git commit -m "推进 web 基线到 <主仓库 commit>" web-base.json web-patches
git push
```

## 给贡献者开权限

两个仓库都公开了，**任何人 fork 都能提 PR，不需要我做任何事**。
只有想直接在这个仓库开分支（省掉 fork）的人才需要加 collaborator：

```powershell
gh api -X PUT repos/grey7213/homer-android/collaborators/<用户名> -f permission=push
gh api -X PUT repos/grey7213/homer-android-apk/collaborators/<用户名> -f permission=push
```

API 里的 `push` 就是界面上的 Write。对方邮箱收到邀请，或直接开
`https://github.com/grey7213/<仓库>/invitations` 接受。

查现状：

```powershell
gh api repos/grey7213/homer-android/collaborators --jq '.[] | "\(.login) \(.role_name)"'
gh api repos/grey7213/homer-android/invitations --jq 'length'   # 待接受的邀请数
```

`write` 能做：在本仓库推分支、开 PR、发 Release、跑 Actions。
**不能**直推 `main`（ruleset 挡着），不能改仓库设置或删仓库。

**发 Release 必须给 write。** `read` 和 `triage` 只能看已发布的，建不了新的 ——
走 fork 路线的人发不了 Release，得把 APK 发给我、我来传，或者我给他们
homer-android-apk 单独的 write 权限（源码仓可以只给 read）。

### 两条路线的差别

| | collaborator（write） | fork |
| --- | --- | --- |
| 谁适合 | 长期合作、要发 Release 的人 | 一次性贡献、不认识的人 |
| 推分支 | 直接推本仓库 | 推自己的 fork |
| 我要做什么 | 先邀请一次 | 什么都不用做 |
| CI | 直接跑 | 首次 PR 我要点一下 Approve |
| 能发 Release | 能 | 不能 |
| 拿得到仓库 secrets | 能（目前没有敏感 secret） | 拿不到 |

fork 的 PR 首次要我在 Actions 页点 Approve and run —— GitHub 对新贡献者
默认不自动跑 workflow。目前 CI 没用任何 secret，所以 fork 跑起来和本仓库分支
效果一样。

