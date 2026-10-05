#!/usr/bin/env python3
r"""把 web 端（frontend/ 与 sillytavern-runtime/）的改动导成一个 git patch。

这两棵树不在本仓库版本控制内 —— 它们是 bootstrap 从 AIXingYue 按 pin 检出的。
所以 web 改动不能靠 commit 交，得交补丁。

补丁的头部记着基线 commit，维护者那边用 `git apply -3` 落地：三方合并会自己处理
「基线之后维护者又改过同一个文件」的情况，冲突会明确报出来，不会像整包覆盖那样
把别人的修复静默退掉。

用法：
    python tools/export_web_patch.py                     # 导到 web-patches/
    python tools/export_web_patch.py --name 修复探索页白屏
    python tools/export_web_patch.py --stat              # 只看改了什么，不写文件
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
TREE = ROOT / ".web-cache" / "tree"
OUT_DIR = ROOT / "web-patches"
WEB_PATHS = ("frontend", "sillytavern-runtime")


def die(message: str) -> None:
    print(f"\n失败：{message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def git(*args: str, check: bool = True, preserve_newlines: bool = False) -> str:
    result = subprocess.run(
        ["git", *args], cwd=TREE, check=False,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    stdout = result.stdout.decode('utf-8', errors='strict' if preserve_newlines else 'replace')
    stderr = result.stderr.decode('utf-8', errors='replace')
    if check and result.returncode != 0:
        die(f"git {' '.join(args)} 失败：\n{(stderr + stdout).strip()[-800:]}")
    # Diff payloads may intentionally contain CRLF source bytes. Universal
    # newline decoding corrupts these while leaving the full-index SHA intact.
    return stdout if preserve_newlines else stdout.replace('\r\n', '\n')


def slug(text: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z一-鿿]+", "-", text).strip("-")
    return cleaned[:60] or "web-patch"


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 web 端改动为 git patch")
    parser.add_argument("--name", default="", help="补丁名，会进文件名，写清改了什么")
    parser.add_argument("--stat", action="store_true", help="只列改动，不写文件")
    parser.add_argument("--include-committed", action="store_true", help="从 pin 导出完整累计补丁，包含本地 Web 提交；需替换旧累计补丁，不能叠加应用")
    args = parser.parse_args()

    if not (TREE / ".git").exists():
        die("没有 .web-cache/tree，先跑 python tools/bootstrap.py")

    base = json.loads((ROOT / "web-base.json").read_text(encoding="utf-8"))
    head = git("rev-parse", "HEAD").strip()
    if head != base["commit"] and not args.include_committed:
        die(f"web 检出停在 {head[:12]}，但 web-base.json 写的是 {base['commit'][:12]}。\n"
            f"       先 python tools/bootstrap.py 对齐基线，再导补丁。")

    diff_base = base["commit"] if args.include_committed else "HEAD"
    git("cat-file", "-e", f"{diff_base}^{{commit}}")
    stat = git("diff", "--stat", diff_base, "--", *WEB_PATHS).strip()
    untracked = [
        line for line in git("ls-files", "--others", "--exclude-standard", "--", *WEB_PATHS).splitlines()
        if line.strip()
    ]

    if not stat and not untracked:
        print("web 端没有改动，不需要补丁。只改了原生壳的话直接提交 android-app 就行。")
        return 0

    if untracked:
        # intent-to-add：让 git diff 把新增文件也算进来，但不真的暂存内容。
        # Windows CreateProcess has a command-line length limit. Large vendor
        # source/map updates must still include every new file in the patch.
        for start in range(0, len(untracked), 40):
            git("add", "-N", "--", *untracked[start:start + 40])
        stat = git("diff", "--stat", diff_base, "--", *WEB_PATHS).strip()
    print("web 端改动：")
    for line in stat.splitlines():
        print(f"  {line}")
    if untracked:
        print(f"  其中新增文件 {len(untracked)} 个：")
        for path in untracked[:20]:
            print(f"    + {path}")
        if len(untracked) > 20:
            print(f"    ... 另有 {len(untracked) - 20} 个")

    if args.stat:
        return 0

    # --binary 保住图片这类改动；full-index 让 git apply -3 能查到 blob 做三方合并。
    patch = git("diff", "--binary", "--full-index", diff_base, "--", *WEB_PATHS, preserve_newlines=True)
    if not patch.strip():
        die("git diff 是空的，但前面看到有改动 —— 检查一下是不是都被 .gitignore 挡了")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    name = f"{stamp}-{slug(args.name)}.patch"
    out = OUT_DIR / name

    header = (
        f"# homer-android web 补丁\n"
        f"# 基线 commit: {base['commit']}\n"
        f"# 基线仓库:   {base['repo']}\n"
        f"# 导出时间:   {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
        f"# 说明:       {args.name or '(未填)'}\n"
        f"#\n"
        f"# 维护者落地方式（在 AIXingYue 工作区）：\n"
        f"#   git apply -3 --stat  <本文件>\n"
        f"#   git apply -3         <本文件>\n"
        f"# 冲突会明确报出来。不要用整目录覆盖代替这一步。\n"
        f"\n"
    )
    # Path.write_text(newline=...) requires Python 3.10; the configured local
    # runtime may be older. File.open supports the same exact LF output there.
    with out.open("w", encoding="utf-8", newline="\n") as output:
        output.write(header + patch)

    print(f"\n补丁已写到 {out.relative_to(ROOT)}（{out.stat().st_size / 1024:.1f} KB）")
    print("把它一起提交进 PR。原生壳的改动照常提交 android-app/ 就行。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
