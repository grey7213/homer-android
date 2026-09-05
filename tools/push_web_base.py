#!/usr/bin/env python3
r"""把主仓库当前的 web 端两棵树推成 homer-android 的 web-base 分支。

web-base 是独立分支：每次基线推进保留前一份快照为父提交，内容只有
frontend/ 与 sillytavern-runtime/ 两棵树。这样贡献者的 bootstrap 能只取一个
浅检出（约 200 MB）而不必克隆主仓库的完整历史。

推完会顺手更新 homer-android/web-base.json 的 pin —— 那个改动要自己提交到 main，
否则贡献者跑 bootstrap 会报「基线动了而 pin 没跟上」。

用法：
    python tools/push_web_base.py
    python tools/push_web_base.py --dry-run     # 只造提交，不推
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ANDROID_REPO = Path(__file__).resolve().parent.parent
MAIN_REPO = Path(os.environ.get("HOMER_MAIN_REPO", r"E:\酒馆开发"))
TREES = ("frontend", "sillytavern-runtime")


def die(message: str) -> None:
    print(f"\n失败：{message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def git(repo: Path, *args: str, check: bool = True, env: dict | None = None) -> str:
    merged = {**os.environ, **(env or {})}
    result = subprocess.run(
        ["git", *args], cwd=repo, check=False, text=True, encoding="utf-8",
        errors="replace", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=merged,
    )
    if check and result.returncode != 0:
        die(f"git {' '.join(args)} 失败（在 {repo}）：\n{(result.stdout or '').strip()[-800:]}")
    return result.stdout or ""


def main() -> int:
    parser = argparse.ArgumentParser(description="推进 homer-android 的 web-base 基线")
    parser.add_argument("--dry-run", action="store_true", help="造提交但不推")
    args = parser.parse_args()

    if not (MAIN_REPO / ".git").is_dir():
        die(f"{MAIN_REPO} 不是 git 仓库。设 HOMER_MAIN_REPO 指向主仓库。")

    dirty = git(MAIN_REPO, "status", "--porcelain", "--", *TREES).strip()
    if dirty:
        count = len(dirty.splitlines())
        die(f"主仓库的 web 树有 {count} 个未提交改动。先提交，再推基线 ——\n"
            f"       否则 pin 指向的 commit 和贡献者实际需要的代码不一致。")

    source = git(MAIN_REPO, "rev-parse", "HEAD").strip()
    print(f"主仓库 HEAD  {source[:12]}")

    # 用独立索引拼出只含两棵树的提交，不碰 homer-android 的工作区和主索引。
    index = ANDROID_REPO / ".git" / "webbase.index"
    index.unlink(missing_ok=True)
    env = {"GIT_INDEX_FILE": str(index)}

    git(ANDROID_REPO, "fetch", "-q", "--depth", "1", "--no-tags", str(MAIN_REPO), "HEAD")
    for tree in TREES:
        git(ANDROID_REPO, "read-tree", f"--prefix={tree}/", f"FETCH_HEAD:{tree}", env=env)
    tree_sha = git(ANDROID_REPO, "write-tree", env=env).strip()
    index.unlink(missing_ok=True)

    for tree in TREES:
        here = git(ANDROID_REPO, "rev-parse", f"FETCH_HEAD:{tree}").strip()
        there = git(MAIN_REPO, "rev-parse", f"HEAD:{tree}").strip()
        if here != there:
            die(f"{tree} 的 tree 对不上：{here[:12]} vs {there[:12]}")
    print(f"两棵树与主仓库 HEAD 逐字节一致")

    pin_path = ANDROID_REPO / "web-base.json"
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    if pin.get("source_commit") == source:
        print(f"\n基线已是 {source[:12]}，无需推进。")
        return 0

    message = (
        f"惑梦 web 端基线 {date.today().isoformat()}\n\n"
        f"从 AIXingYue 工作区取 frontend/ 与 sillytavern-runtime/ 两棵树，供 homer-android\n"
        f"的 bootstrap 装配可构建工作区。保留前一份基线，支持旧 pin 恢复与正常快进推送。\n\n"
        f"源 commit: {source}\n"
    )
    git(ANDROID_REPO, "fetch", "-q", "origin", "web-base")
    previous = git(ANDROID_REPO, "rev-parse", "FETCH_HEAD").strip()
    if previous != pin["commit"]:
        die("远端 web-base 已变化，请先同步最新 pin，避免覆盖其他维护者的发布。")
    commit = subprocess.run(
        ["git", "commit-tree", tree_sha, "-p", previous], cwd=ANDROID_REPO, input=message,
        text=True, encoding="utf-8", capture_output=True, check=True,
    ).stdout.strip()
    git(ANDROID_REPO, "branch", "-f", "web-base", commit)
    print(f"造出基线提交 {commit[:12]}（父快照 {previous[:12]}）")


    if args.dry_run:
        print("\n--dry-run：没有推送。推的话去掉这个开关。")
        return 0

    print("推 web-base（约 140 MB，慢）...")
    git(ANDROID_REPO, "push", "-q", "origin", "web-base:web-base")

    pin.update({
        "commit": commit,
        "source_commit": source,
        "updated": date.today().isoformat(),
    })
    pin_path.write_text(json.dumps(pin, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n已推 web-base = {commit[:12]}，web-base.json 的 pin 已更新。")
    print("记得提交这个 pin 到 main，否则贡献者 bootstrap 会报基线不符：")
    print(f'  cd {ANDROID_REPO}')
    print(f'  git commit -m "推进 web 基线到 {source[:12]}" web-base.json && git push')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

