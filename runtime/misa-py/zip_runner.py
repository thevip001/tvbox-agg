#!/usr/bin/env python3
"""Safe, bounded loader for MisaTV-style Python spider ZIP bundles."""
import os, stat, sys, tempfile, zipfile
import runner

MAX_ARCHIVE = 10 * 1024 * 1024
MAX_UNPACKED = 32 * 1024 * 1024
MAX_FILES = 2000

def main():
    if len(sys.argv) < 2 or sys.argv[1] != "--archive":
        runner.main()
        return
    if len(sys.argv) < 7:
        raise SystemExit("usage: --archive ZIP ENTRY CLASS METHOD EXT")
    archive, entry, cls, method, ext = sys.argv[2:7]
    if os.path.getsize(archive) > MAX_ARCHIVE:
        raise ValueError("spider ZIP exceeds 10 MiB")
    with zipfile.ZipFile(archive) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_FILES:
            raise ValueError("spider ZIP contains too many entries")
        total = sum(i.file_size for i in infos)
        if total > MAX_UNPACKED:
            raise ValueError("spider ZIP expands beyond 32 MiB")
        root = tempfile.mkdtemp(prefix="spider-", dir="/tmp")
        root_real = os.path.realpath(root)
        for info in infos:
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or any(part in ("", ".", "..") for part in name.split("/") if part != ""):
                if name.endswith("/") and all(p not in ("..", ".") for p in name.split("/")):
                    pass
                else:
                    raise ValueError("unsafe ZIP path: " + info.filename)
            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                raise ValueError("ZIP symlinks are not allowed")
            target = os.path.realpath(os.path.join(root, name))
            if target != root_real and not target.startswith(root_real + os.sep):
                raise ValueError("ZIP path escapes extraction directory")
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as dst:
                    remaining = info.file_size
                    while remaining:
                        chunk = src.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("truncated ZIP entry")
                        dst.write(chunk)
                        remaining -= len(chunk)
                    os.chmod(target, 0o444)
    script = os.path.realpath(os.path.join(root, entry))
    if not script.startswith(root_real + os.sep) or not os.path.isfile(script) or not script.lower().endswith(".py"):
        raise ValueError("entry must name a Python file inside the ZIP")
    sys.argv = [runner.__file__, script, cls, method, ext]
    runner.main()

if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:
        runner._fail(exc)
