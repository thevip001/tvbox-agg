# MisaTV JS runtime notice

`bootstrap.js` is copied from yagami-hue/MisaTV commit `fd0106a9d1a450d46925ccb8cf47feef3acf6350`, file `lib/services/js_spider/js_bootstrap.dart` (the `spiderJsBootstrap` raw string). MisaTV is GPL-3.0; see LICENSE. The QuickJS Python binding is a separately licensed dependency.

This adapter embeds the QuickJS engine via the `quickjs` Python package and uses the upstream bootstrap and spider dispatch contract. It is not the Flutter `flutter_js` package binary itself. Native host channels are implemented in Python; network is deliberately disabled in the sandbox, remote module loading is unavailable, and local persistence is ephemeral. ESM transformation and MisaTV bundled JS libraries are not yet included; CommonJS/global scripts are supported. No Node/V8 fallback is used.
