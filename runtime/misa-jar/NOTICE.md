# MisaTV JVM runtime notice

The desktop JVM host, Android compatibility stubs and shim artifacts are obtained at image-build time from yagami-hue/MisaTV commit `fd0106a9d1a450d46925ccb8cf47feef3acf6350`. MisaTV is licensed under GPL-3.0; see `runtime/misa-py/LICENSE` for the license text and the upstream repository for the corresponding source. Maven dependencies retain their respective upstream licenses.

The runtime is intentionally executed with Docker networking disabled. This validates actual JVM class loading, SpiderHost dispatch and the fixture's `homeContent(boolean)` method, but cannot validate spiders that require external network access or Android-native/JNI-only payloads.
