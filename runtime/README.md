# MisaTV runtime adapters

Build the isolated runtimes:

```sh
docker build -t tvbox-agg/misa-py:3.11 runtime/misa-py
docker build -t tvbox-agg/misa-jar:17 runtime/misa-jar
```

Run a Python spider home probe:

```sh
node scripts/runtime-check.mjs --kind py --source ./site.py --class Spider --ext ''
```

Run a regular Java spider through MisaTV's desktop SpiderHost:

```sh
node scripts/runtime-check.mjs --kind jar --source ./spider.jar --class com.example.spider.Site
```

Both runtimes are sandboxed with Docker networking disabled, a read-only root filesystem, non-root UID, dropped Linux capabilities, no-new-privileges, and resource limits. Online spider probes are therefore uncertain when they need network access. JAR support targets ordinary JVM-compatible payloads; Android ART/DEX, JNI and protected-shell payloads are not guaranteed. JS remains unsupported until the actual QuickJS native host bridge is available. See [the integration notes](../docs/MISATV_RUNTIME_INTEGRATION.md).

Runtime results are not connected to production source deletion.
