#!/usr/bin/env python3
r"""把 homer-android 装配成一个能直接 gradlew 的工作区。

原生壳的源码在本仓库，web 端（frontend/ 与 sillytavern-runtime/）的真源在
grey7213/AIXingYue。Gradle 的 syncHomerClientAssets 从 android-app 的父目录读这两棵
树，所以构建前必须先把它们按 web-base.json 里 pin 的 commit 取下来放到仓库根。

本脚本做四件事：
  1. 按 web-base.json 的 commit 浅克隆 AIXingYue 到 .web-cache/tree（稀疏，只要那两棵树）
  2. 在仓库根建 frontend / sillytavern-runtime 到该检出的链接（Windows 目录联接 / POSIX 符号链接）
  3. 装 sillytavern-runtime 的运行时依赖（compileHomerDialogueLibraries 要 webpack）
  4. 缺 local.properties 就按 ANDROID_HOME 生成

链接而不是复制，是为了让改 web 文件时改的就是那个 git 检出本身 ——
`python tools/export_web_patch.py` 因此能直接导出对着真实 commit 的 patch，
维护者那边 `git apply -3` 就能落地，不会像整体覆盖那样静默回退别人的修复。

用法：
    python tools/bootstrap.py              # 全量装配
    python tools/bootstrap.py --skip-npm   # 只装 web 树，不装 node 依赖
    python tools/bootstrap.py --check      # 只体检环境，不动任何文件
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".web-cache"
TREE = CACHE / "tree"
IS_WINDOWS = platform.system() == "Windows"


def say(message: str) -> None:
    print(message, flush=True)


def die(message: str) -> None:
    print(f"\n失败：{message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def run(command: list[str], *, cwd: Path | None = None, check: bool = True) -> str:
    result = subprocess.run(
        command, cwd=cwd, check=False, text=True, encoding="utf-8",
        errors="replace", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if check and result.returncode != 0:
        tail = "\n".join((result.stdout or "").strip().splitlines()[-15:])
        die(f"命令失败（exit {result.returncode}）：{' '.join(command)}\n{tail}")
    return result.stdout or ""


def load_base() -> dict:
    path = ROOT / "web-base.json"
    if not path.exists():
        die("仓库根缺 web-base.json，无法确定 web 端基线")
    data = json.loads(path.read_text(encoding="utf-8"))
    for field in ("repo", "commit", "trees"):
        if not data.get(field):
            die(f"web-base.json 缺字段 {field}")
    if len(data["commit"]) != 40:
        die(f"web-base.json 的 commit 必须是完整 40 位 SHA，当前是 {data['commit']!r}")
    data.setdefault("ref", "web-base")
    return data



def check_tool(name: str, args: list[str], hint: str) -> str | None:
    exe = shutil.which(name)
    if not exe:
        say(f"  [缺] {name} —— {hint}")
        return None
    version = run([exe, *args], check=False).strip().splitlines()
    say(f"  [有] {name}  {version[0] if version else ''}".rstrip())
    return exe


def check_env(*, strict: bool) -> dict[str, str | None]:
    say("检查环境：")
    found = {
        "git": check_tool("git", ["--version"], "装 Git for Windows"),
        "node": check_tool("node", ["--version"], "装 Node 20 以上，webpack 要用"),
        "npm": check_tool("npm", ["--version"], "跟 Node 一起装"),
    }

    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    local_properties = ROOT / "android-app" / "local.properties"
    if sdk and Path(sdk).is_dir():
        say(f"  [有] Android SDK  {sdk}")
    elif local_properties.exists():
        say(f"  [有] Android SDK  由 {local_properties.name} 指定")
    else:
        say("  [缺] Android SDK —— 设 ANDROID_HOME，或在 android-app/local.properties 写 sdk.dir")

    java_home = os.environ.get("JAVA_HOME")
    if java_home and (Path(java_home) / "bin").is_dir():
        say(f"  [有] JAVA_HOME  {java_home}")
    else:
        say("  [缺] JAVA_HOME —— 需要 JDK 17 以上，Android Studio 自带的 jbr 就行")

    if strict:
        missing = [name for name, path in found.items() if not path]
        if missing:
            die(f"缺少必需工具：{'、'.join(missing)}")
    return found


def fetch_web_tree(git: str, base: dict) -> None:
    """把 web-base.json pin 的 commit 稀疏检出到 .web-cache/tree。"""
    commit = base["commit"]
    trees = list(base["trees"])
    repo = os.environ.get("HOMER_WEB_REPO") or base["repo"]
    if repo != base["repo"]:
        say(f"\n用镜像取 web 端：{repo}")

    if not (TREE / ".git").exists():
        say(f"\n首次克隆 web 端到 {TREE.relative_to(ROOT)}（稀疏 + 无历史，约 200 MB）")
        TREE.mkdir(parents=True, exist_ok=True)
        run([git, "init", "-q"], cwd=TREE)
        run([git, "remote", "add", "origin", repo], cwd=TREE)
        run([git, "sparse-checkout", "init", "--no-cone"], cwd=TREE)
        run([git, "sparse-checkout", "set", "--no-cone", *trees], cwd=TREE)
    else:
        run([git, "remote", "set-url", "origin", repo], cwd=TREE)


    current = run([git, "rev-parse", "HEAD"], cwd=TREE, check=False).strip()
    if current == commit:
        say(f"\nweb 端已在 {commit[:12]}，跳过下载")
    else:
        say(f"\n取 web 端 {commit[:12]}（这一步要联网，慢的话是在下 sillytavern-runtime）")
        fetched = run([git, "fetch", "-q", "--depth", "1", "origin", commit],
                      cwd=TREE, check=False)
        if "not our ref" in fetched or "error" in fetched.lower():
            # GitHub 默认不允许按任意 SHA 直取，退回抓 ref 再核对。
            ref = base.get("ref", "web-base")
            say(f"  按 SHA 直取被服务端拒绝，退回抓 {ref}")
            run([git, "fetch", "-q", "--depth", "1", "origin", ref], cwd=TREE)
            head = run([git, "rev-parse", "FETCH_HEAD"], cwd=TREE).strip()
            if head != commit:
                die(f"{ref} 现在是 {head[:12]}，但 web-base.json pin 的是 {commit[:12]}。\n"
                    f"       说明基线动了而 pin 没跟上 —— 让维护者更新 web-base.json，"
                    f"或先 git pull 拿最新的 pin。")
        run([git, "checkout", "-q", "--force", commit], cwd=TREE)
        say(f"  已检出 {commit[:12]}")



    for tree in trees:
        if not (TREE / tree).is_dir():
            die(f"检出后没有 {tree}/，web-base.json 的 trees 可能写错了")


def link_into_root(base: dict) -> None:
    """在仓库根建 frontend / sillytavern-runtime 指向稀疏检出。

    Gradle 从 rootProject.projectDir.parentFile 读这两棵树，也就是仓库根。
    用链接而不是复制：改 web 文件时改的就是那个 git 检出，export_web_patch.py
    才能直接 git diff 出对着真实 commit 的补丁。
    """
    say("")
    for tree in base["trees"]:
        target = ROOT / tree
        source = TREE / tree

        if target.is_symlink() or (IS_WINDOWS and target.is_dir() and is_junction(target)):
            existing = Path(os.path.realpath(target))
            if existing == source.resolve():
                say(f"  {tree}/ 链接已就位")
                continue
            unlink_dir(target)
        elif target.exists():
            die(f"{tree}/ 已存在且不是链接。它应该由 bootstrap 装配 ——\n"
                f"       确认里面没有你自己的东西后删掉，再重跑：{target}")

        if IS_WINDOWS:
            # 目录联接不需要管理员权限，符号链接在未开开发者模式的 Windows 上要。
            # mklink 是 cmd 内建命令，只认反斜杠路径。
            run(["cmd", "/c", "mklink", "/J",
                 str(target).replace("/", "\\"), str(source).replace("/", "\\")])
        else:
            target.symlink_to(source, target_is_directory=True)
        say(f"  {tree}/ -> {source.relative_to(ROOT)}")



def is_junction(path: Path) -> bool:
    try:
        return bool(os.readlink(path))
    except OSError:
        return False


def unlink_dir(path: Path) -> None:
    if IS_WINDOWS and not path.is_symlink():
        run(["cmd", "/c", "rmdir", str(path).replace("/", "\\")])
    else:
        path.unlink()



def install_runtime_deps(npm: str | None) -> None:
    """装 sillytavern-runtime 的运行时依赖。

    Gradle 的 compileHomerDialogueLibraries 会 `node docker/build-lib.js`，那个脚本
    import webpack —— webpack 在 package.json 的 dependencies 里，所以 --omit=dev
    够用，能省掉一大堆 @types 和 eslint。
    """
    runtime = TREE / "sillytavern-runtime"
    marker = runtime / "node_modules" / ".homer-bootstrap"
    if marker.exists():
        say("\nnode 依赖已装（删掉 sillytavern-runtime/node_modules/.homer-bootstrap 可强制重装）")
        return
    if not npm:
        die("没有 npm，装不了 webpack；构建会在 compileHomerDialogueLibraries 挂掉")

    say("\n装 sillytavern-runtime 的运行时依赖（首次约 3-8 分钟，装完约 320 MB）")
    run([npm, "install", "--omit=dev", "--no-audit", "--no-fund"], cwd=runtime)
    if not (runtime / "node_modules" / "webpack").is_dir():
        die("npm install 装完还是没有 webpack，构建会挂在 compileHomerDialogueLibraries")
    marker.write_text("bootstrap 装的，删掉即可强制重装\n", encoding="utf-8")
    say("  webpack 就位")


def ensure_local_properties() -> None:
    path = ROOT / "android-app" / "local.properties"
    if path.exists():
        return
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        say("\n没有 ANDROID_HOME，跳过生成 local.properties；"
            "构建前请自己写 sdk.dir")
        return
    escaped = str(Path(sdk)).replace("\\", "\\\\").replace(":", "\\:")
    path.write_text(f"sdk.dir={escaped}\n", encoding="utf-8")
    say(f"\n生成 android-app/local.properties  sdk.dir={sdk}")


def main() -> int:
    parser = argparse.ArgumentParser(description="装配 homer-android 可构建工作区")
    parser.add_argument("--check", action="store_true", help="只体检环境，不改任何文件")
    parser.add_argument("--skip-npm", action="store_true", help="不装 node 依赖")
    args = parser.parse_args()

    base = load_base()
    tools = check_env(strict=not args.check)
    if args.check:
        say(f"\nweb 基线：{base['commit'][:12]}  ({base['repo']})")
        return 0

    fetch_web_tree(tools["git"], base)
    link_into_root(base)
    if not args.skip_npm:
        install_runtime_deps(tools["npm"])
    ensure_local_properties()

    say("\n装配完成。构建：")
    if IS_WINDOWS:
        say(r"  cd android-app")
        say(r"  .\gradlew.bat testDebugUnitTest assembleDebug")
    else:
        say("  cd android-app")
        say("  ./gradlew testDebugUnitTest assembleDebug")
    return 0



if __name__ == "__main__":
    raise SystemExit(main())
