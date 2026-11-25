# MisaTV runtime adapter

Build the CPython 3.11 runtime image:

```sh
docker build -t tvbox-agg/misa-py:3.11 runtime/misa-py
```

Run an isolated Py spider home probe:

```sh
node scripts/runtime-check.mjs --kind py --source ./site.py --class Spider --ext ''
```

The runner uses the MisaTV CPython runner and base Spider implementation. Each execution is a non-root, read-only, no-network Docker container with CPU, memory and PID limits. The no-network policy is deliberate: third-party spiders are arbitrary code and must not be allowed to reach private networks, localhost or cloud metadata. Online source validation requires a separately deployed egress-filtering proxy and is not enabled here.

JS and JAR currently return `runtime-unsupported`: MisaTV's QuickJS host bridge and Android/JVM SpiderHost have not been ported. Node/V8 or plain JVM execution would not be equivalent and must not be counted as a successful runtime test.

The fixture workflow tests only repository-owned code; it never executes harvested third-party sources. Runtime results are not yet used to remove sources in the daily pipeline.
