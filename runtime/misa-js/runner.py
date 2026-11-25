#!/usr/bin/env python3
import base64, hashlib, json, os, sys, traceback, urllib.request, urllib.error
import quickjs
from esm_transform import transform_to_cjs, ESMTransformError

BOOTSTRAP = open("/opt/misa/bootstrap.js", encoding="utf-8").read()
LOCAL = {}

def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: runner.py /work/site.js [api] [ext]")
    path = sys.argv[1]
    api = sys.argv[2] if len(sys.argv) > 2 else ""
    ext = sys.argv[3] if len(sys.argv) > 3 else ""
    if os.path.getsize(path) > 2 * 1024 * 1024:
        raise ValueError("JS source exceeds 2 MiB")
    source = open(path, encoding="utf-8-sig").read()
    original_source = source
    try:
        source = transform_to_cjs(source, api or path)
    except ESMTransformError as exc:
        print(json.dumps({"status":"runtime-unsupported","errorType":"esm-transform-unsupported","error":str(exc)}, ensure_ascii=False))
        return
    ctx = quickjs.Context()
    ctx.set_memory_limit(96 * 1024 * 1024)
    ctx.set_max_stack_size(512 * 1024)
    def send_message(name, payload):
        try: data = json.loads(payload or "{}")
        except Exception: data = {}
        if name == "__net":
            url = str(data.get("url", ""))
            try:
                from urllib.parse import urlsplit
                parsed = urlsplit(url)
                if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError("only absolute HTTP/HTTPS URLs are supported")
                method = str(data.get("method", "get")).upper()
                if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
                    raise ValueError("HTTP method is not allowed")
                headers = {str(k): str(v) for k, v in (data.get("headers") or {}).items()
                           if str(k).lower() not in ("proxy-authorization", "proxy-connection", "host", "content-length")}
                body = data.get("body")
                request = urllib.request.Request(url, data=(str(body).encode() if body not in (None, "") else None),
                                                 headers=headers, method=method)
                timeout = max(1, min(20, int(data.get("timeout", 10000)) / 1000))
                try:
                    response = urllib.request.urlopen(request, timeout=timeout)
                except urllib.error.HTTPError as response:
                    pass
                with response:
                    raw = response.read(4 * 1024 * 1024 + 1)
                    if len(raw) > 4 * 1024 * 1024:
                        raise ValueError("HTTP response exceeds 4 MiB")
                    charset = str(data.get("charset") or response.headers.get_content_charset() or "utf-8")
                    try: content = raw.decode(charset, "replace")
                    except LookupError: content = raw.decode("utf-8", "replace")
                    return json.dumps({"headers": dict(response.headers.items()), "content": content,
                                       "status": response.status, "ok": 200 <= response.status < 400,
                                       "url": response.geturl()}, ensure_ascii=False)
            except Exception as exc:
                return json.dumps({"headers": {}, "content": "", "status": 0, "ok": False,
                                   "error": str(exc)}, ensure_ascii=False)
        if name == "__module":
            spec = str(data.get("spec", "")).split("?")[0].split("#")[0]
            base = os.path.basename(spec)
            candidates = [base] if base.endswith(".js") else [base + ".js", base]
            for filename in candidates:
                libpath = os.path.join("/opt/misa/libs", filename)
                if os.path.isfile(libpath):
                    with open(libpath, encoding="utf-8-sig") as libfile:
                        module_source = transform_to_cjs(libfile.read(), "lib:" + filename)
                    return json.dumps({"ok": True, "key": "lib:" + filename, "source": module_source})
            return json.dumps({"ok": False})
        if name == "__local":
            key = str(data.get("key",""))
            op = data.get("op")
            if op == "get": return str(LOCAL.get(key,""))
            if op == "set": LOCAL[key] = str(data.get("value","")); return "1"
            if op == "del": LOCAL.pop(key,None); return "1"
        if name in ("__md5","__sha1","__sha256"):
            algo = name[2:]
            return hashlib.new(algo, str(data.get("s","")).encode()).hexdigest()
        if name == "__b64e":
            return base64.b64encode(str(data.get("s","")).encode()).decode()
        if name == "__b64d":
            try: return base64.b64decode(str(data.get("s",""))).decode("utf-8","replace")
            except Exception: return ""
        return ""
    ctx.add_callable("sendMessage", send_message)
    ctx.add_callable("print", lambda *xs: sys.stderr.write(" ".join(map(str,xs))+"\\n"))
    ctx.eval(BOOTSTRAP)
    ctx.eval("if (typeof globalThis.SpiderDebug === 'undefined') { globalThis.SpiderDebug = { log:function(){}, info:function(){}, warn:function(){}, error:function(){} }; }")
    is_module = bool(__import__("re").search(r"(^|[\n;])\s*(import|export)\b", original_source) or __import__("re").search(r"\bmodule\.exports\b|\bexports\s*\.", source))
    init = ctx.get("__kniephosInitSpider")
    init_result = json.loads(init(source, api, json.dumps(ext, ensure_ascii=False), is_module))
    if not init_result.get("ok"):
        print(json.dumps({"status":"runtime-error","errorType":"spider-init-failed","error":init_result.get("error","unknown")}, ensure_ascii=False))
        return
    ctx.eval("globalThis.__runtimeResult = null;")
    invoke = ctx.get("__kniephosInvoke")
    # Invoke through the upstream bootstrap; pump QuickJS promise jobs until settled.
    ctx.eval("__kniephosInvoke('home', []).then(v => { globalThis.__runtimeResult = v; }, e => { globalThis.__runtimeResult = JSON.stringify({__error:String(e)}); });")
    for _ in range(10000):
        if ctx.eval("globalThis.__runtimeResult !== null"): break
        if not ctx.execute_pending_job(): break
    raw = ctx.eval("globalThis.__runtimeResult")
    if raw is None:
        raise RuntimeError("QuickJS promise did not settle")
    try: data = json.loads(raw) if isinstance(raw,str) else raw
    except Exception: data = raw
    if isinstance(data,dict) and data.get("__error"):
        print(json.dumps({"status":"runtime-error","errorType":"spider-home-failed","error":data["__error"]},ensure_ascii=False)); return
    has = bool(data) and (not isinstance(data,(dict,list)) or bool(data.get("list") or data.get("class") or data))
    print(json.dumps({"status":"runtime-home" if has else "runtime-empty","runtimeVersion":"QuickJS / MisaTV bootstrap","method":"homeContent/home","style":init_result.get("style"),"data":data,"network":{"mode":"disabled","requests":"blocked"}},ensure_ascii=False))

if __name__ == "__main__":
    try: main()
    except BaseException as e:
        print(json.dumps({"status":"runtime-error","errorType":"quickjs-runner-error","error":str(e),"traceback":traceback.format_exc()},ensure_ascii=False))
