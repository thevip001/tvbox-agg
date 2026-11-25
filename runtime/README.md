# MisaTV runtime adapters

Build the isolated runtimes:

```sh
docker build -t tvbox-agg/misa-py:3.11 runtime/misa-py
docker build -t tvbox-agg/misa-js:quickjs runtime/misa-js
docker build -t tvbox-agg/misa-jar:17 runtime/misa-jar
```

Py source and ZIP bundle:

```sh
node scripts/runtime-check.mjs --kind py --source ./site.py --class Spider
node scripts/runtime-check.mjs --kind py --archive ./spider.zip --entry 0.py --class Spider --ext '{}'
```

JS CommonJS/global rule on QuickJS with MisaTV bootstrap:

```sh
node scripts/runtime-check.mjs --kind js --source ./rule.js --api https://example.invalid/drpy2.min.js --ext '{}'
```

Ordinary JVM-compatible Java spider:

```sh
node scripts/runtime-check.mjs --kind jar --source ./spider.jar --class com.example.spider.Site
```

All adapters use Docker with networking disabled, read-only rootfs, non-root UID, dropped Linux capabilities, no-new-privileges and resource limits. Py ZIP extraction is bounded and rejects traversal/symlinks. JS uses QuickJS (not Node/V8) and MisaTV's vendored bootstrap, but the ESM transformer, bundled DOM/crypto libraries, remote module loader and network host remain unsupported/blocked. JAR does not promise Android ART/DEX/JNI compatibility. See [integration notes](../docs/MISATV_RUNTIME_INTEGRATION.md).

`runtime-home` is an offline runtime execution result, not proof that a production source's remote API is reachable. Runtime results are not connected to production source deletion.