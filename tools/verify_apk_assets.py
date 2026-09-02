#!/usr/bin/env python3
r"""校验 APK 里真的带上了 web 端资源，而不是打了个空壳。

这条检查是为一个具体的坑存在的：syncHomerClientAssets 从仓库根读 frontend/ 与
sillytavern-runtime/public/，如果那两棵树没装配、或者新加的 js 模块没被同步进去，
构建照样成功，只是包里少文件 —— 运行时 import 404，页面白屏。编译期看不出来。

做三件事：
  1. assets/client/index.txt 存在且条目数合理
  2. frontend/ 下的每个文件都能在包里找到对应条目（按相对路径核对）
  3. runtime 的 lib.js 在包里且不是空的

用法：
    python tools/verify_apk_assets.py
    python tools/verify_apk_assets.py --apk 别的路径.apk
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_APK = ROOT / "android-app/app/build/outputs/apk/debug/app-debug.apk"
SKIP_PARTS = {"node_modules", "__pycache__", ".git"}


def die(message: str) -> None:
    print(f"\n失败：{message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 APK 内的 web 资源完整性")
    parser.add_argument("--apk", type=Path, default=DEFAULT_APK)
    args = parser.parse_args()

    if not args.apk.exists():
        die(f"找不到 APK：{args.apk}")

    with zipfile.ZipFile(args.apk) as apk:
        names = set(apk.namelist())
        index_name = "assets/client/index.txt"
        if index_name not in names:
            die(f"{index_name} 不在包里 —— syncHomerClientAssets 大概没跑")
        index = [
            line for line in
            apk.read(index_name).decode("utf-8").splitlines() if line.strip()
        ]
        lib = "assets/client/runtime/lib.js"
        if lib not in names:
            die(f"{lib} 不在包里 —— compileHomerDialogueLibraries 的产物没进去")
        lib_size = apk.getinfo(lib).file_size
        if lib_size < 100_000:
            die(f"{lib} 只有 {lib_size} 字节，webpack 产物不该这么小")

    web_root = ROOT / "frontend"
    if not web_root.is_dir():
        die("仓库根没有 frontend/，先跑 python tools/bootstrap.py")

    def packable(rel: Path) -> bool:
        # aapt 会丢掉 assets 里以点开头的目录和文件（.well-known/、.gitkeep 这类），
        # 生产包也一样缺，所以这些不算漏。
        return not (SKIP_PARTS & set(rel.parts)) and not any(
            part.startswith(".") for part in rel.parts)

    expected, skipped = [], []
    for path in web_root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(web_root)
        (expected if packable(rel) else skipped).append(rel.as_posix())

    missing = [rel for rel in expected if f"assets/client/web/{rel}" not in names]

    print(f"APK           {args.apk.name}  {args.apk.stat().st_size / 1048576:.1f} MB")
    print(f"资源清单条目   {len(index)}")
    print(f"runtime lib.js {lib_size / 1024:.0f} KB")
    print(f"frontend 文件  {len(expected)} 个，缺 {len(missing)} 个"
          + (f"（另有 {len(skipped)} 个点开头的文件按 aapt 规则不入包）" if skipped else ""))

    if missing:
        for rel in missing[:20]:
            print(f"  缺 frontend/{rel}")
        if len(missing) > 20:
            print(f"  ... 另有 {len(missing) - 20} 个")
        die("有前端文件没进 APK。运行时会 404，页面白屏。")

    print("\n通过：前端与运行时资源都在包里。")
    return 0



if __name__ == "__main__":
    raise SystemExit(main())

