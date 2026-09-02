#!/usr/bin/env python3
r"""把 web-patches/ 里的补丁落到已装配的 web 检出上。

贡献者本地一般不用手跑这个 —— export_web_patch.py 导出时改动就在工作区里了。
它主要给两个场景：
  1. CI：checkout 拿到的是 PR 里的补丁文件，装配完 web 基线后要把补丁铺上去再构建
  2. 换机器 / 重跑 bootstrap 之后，把自己 PR 里的补丁重新铺回来

用 git apply -3：基线之后基线本身又动过的情况会走三方合并，冲突明确报出来。

用法：
    python tools/apply_web_patches.py            # 铺 web-patches/ 下全部补丁
    python tools/apply_web_patches.py --strict   # 补丁基线与当前 pin 不一致就直接失败（CI 用）
    python tools/apply_web_patches.py --check    # 只试算能不能干净落地
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
TREE = ROOT / ".web-cache" / "tree"
PATCH_DIR = ROOT / "web-patches"
BASE_RE = re.compile(r"^#\s*基线 commit:\s*([0-9a-f]{40})", re.MULTILINE)


def die(message: str) -> None:
    print(f"\n失败：{message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def git(*args: str, check: bool = True) -> tuple[int, str]:
    result = subprocess.run(
        ["git", *args], cwd=TREE, check=False, text=True,
        encoding="utf-8", errors="replace",
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if check and result.returncode != 0:
        die(f"git {' '.join(args)} 失败：\n{(result.stdout or '').strip()[-800:]}")
    return result.returncode, result.stdout or ""


def main() -> int:
    parser = argparse.ArgumentParser(description="把 web-patches/ 的补丁落到 web 检出上")
    parser.add_argument("--check", action="store_true", help="只试算，不真的改文件")
    parser.add_argument("--strict", action="store_true",
                        help="补丁基线与当前 pin 不一致就失败（CI 用）")
    args = parser.parse_args()

    patches = sorted(p for p in PATCH_DIR.glob("*.patch")) if PATCH_DIR.is_dir() else []
    if not patches:
        print("web-patches/ 里没有补丁，跳过。")
        return 0

    if not (TREE / ".git").exists():
        die("没有 .web-cache/tree，先跑 python tools/bootstrap.py")

    pinned = json.loads((ROOT / "web-base.json").read_text(encoding="utf-8"))["commit"]
    head = git("rev-parse", "HEAD")[1].strip()
    if head != pinned:
        die(f"web 检出停在 {head[:12]}，pin 是 {pinned[:12]}。先跑 bootstrap 对齐。")

    failed = 0
    for patch in patches:
        text = patch.read_text(encoding="utf-8", errors="replace")
        declared = BASE_RE.search(text)
        label = patch.name

        if declared and declared.group(1) != pinned:
            message = (f"{label} 的基线是 {declared.group(1)[:12]}，当前 pin 是 {pinned[:12]}")
            if args.strict:
                print(f"  [基线不符] {message}")
                failed += 1
                continue
            print(f"  [警告] {message}，仍尝试三方合并")

        command = ["apply", "-3", "--check" if args.check else "--index", str(patch)]
        code, output = git(*command, check=False)
        tail = output.strip().splitlines()[-3:]
        if code == 0 and "with conflicts" not in output:
            print(f"  [落地] {label}")
        else:
            print(f"  [冲突] {label}")
            for line in tail:
                print(f"          {line}")
            failed += 1

    if failed:
        die(f"{failed} 个补丁没能干净落地。冲突文件里有 <<<<<<< 标记，人工合完再重跑。")
    print(f"\n{len(patches)} 个补丁全部落地。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

