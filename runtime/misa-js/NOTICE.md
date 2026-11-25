# MisaTV JS runtime notice

This directory vendors the following from yagami-hue/MisaTV commit `fd0106a9d1a450d46925ccb8cf47feef3acf6350`:

- `lib/services/js_spider/js_bootstrap.dart`: the original `spiderJsBootstrap` raw JavaScript string, stored as `bootstrap.js`
- `lib/services/js_spider/esm_transform.dart`: the limited regex ESM-to-CJS transformation contract, ported to Python as `esm_transform.py`
- `assets/js_lib/*.js`: MisaTV's bundled JS libraries

MisaTV is GPL-3.0; see LICENSE. The QuickJS Python binding is a separately licensed dependency.

The adapter runs the QuickJS engine through the `quickjs` Python binding, not Node/V8. It implements the upstream bootstrap's synchronous `sendMessage` bridge for local storage, hashes, Base64, and bundled module loading. HTTP requests and remote module downloads are blocked by the no-network container. The transformer intentionally matches MisaTV's documented limited regex transform and returns unsupported for `export * from`; it is not a full ECMAScript compiler.
