# MisaTV Python runtime notices

This directory vendors the following files from <https://github.com/yagami-hue/MisaTV>:

- `runner.py`
- `base/spider.py`

Upstream project license: GPL-3.0. The unmodified upstream license text is in [LICENSE](./LICENSE). These files are copied for the purpose of executing the same CPython spider contract. Changes made in this repository are identified in git history. The Python dependencies are separately licensed; see their respective package metadata. They are not relicensed as GPL by this notice.

Runtime image uses CPython 3.11 on Debian slim. Image builds should be pinned by digest before production deployment.
