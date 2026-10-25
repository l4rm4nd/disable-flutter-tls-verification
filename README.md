# disable-flutter-tls-verification
A Frida script that disables Flutter's TLS verification

This script works on Android (arm, arm64, x64 and x86), iOS (arm64), Windows and Linux (x64). It uses pattern matching to find [ssl_verify_peer_cert in handshake.cc](https://github.com/google/boringssl/blob/master/ssl/handshake.cc#L323)

You can use it via Frida by downloading disable-flutter-tls.js or by using Frida codeshare:

```bash
# new offsets found and verified by GLM-5.3 LLM
frida -U -f your.package.name -l disable-flutter-tls-v2.js

# new offsets for Android (arm64) and iOS (arm64) found manually
frida -U -f your.package.name -l disable-flutter-tls-v1.js

# or Frida codeshare
frida -U --codeshare l4rm4nd/disable-flutter-tls-v2 -f YOUR_BINARY
frida -U --codeshare l4rm4nd/disable-flutter-tls-v1 -f YOUR_BINARY

# on iOS you may want to use a combination to make MitM proxying work
# make sure to set your proxy ip in force-ios-flutter-proxy.js
frida -U -f your.package.name -l disable-flutter-tls-v2.js -l force-ios-flutter-proxy.js
```

Further information can be found in [this blogpost](https://blog.lrvt.de/intercepting-flutter-traffic-using-frida-and-proxy-tricks/) and [this one](https://blog.nviso.eu/2022/08/18/intercept-flutter-traffic-on-ios-and-android-http-https-dio-pinning/).

## Pattern coverage

The patterns in `disable-flutter-tls.js` are validated against the binaries in [libflutter_samples](libflutter_samples) (run `python3 libflutter_samples/verify.py`). The offsets of the most recent engine binaries below were additionally confirmed against the DWARF debug symbols published in the official engine artifacts, so they are the actual function locations.

Latest engine verified: **Flutter 3.47.8** (engine `cf636b1dfb818dd6a3ff16e390e93b1a036969c8`, October 2026).

| Platform | Arch | Latest sample (MD5) | `ssl_verify_peer_cert` | `ssl_crypto_x509_session_verify_cert_chain` (fallback) |
| --- | --- | --- | --- | --- |
| Android | arm64 | `2ccdb88889559d26aeb73477472fdaa4` | 0x773354 | 0x781690 |
| Android | arm | `d68d30655a0a5df8ae5a5edabd4ef921` | 0x55c010 | 0x568244 |
| Android | x64 | `91882440877b05c3f4a7ad64c6ab1d11` | 0x84af03 | 0x85d73d |
| Android | x86 | – | ✗ | ✗ |
| Android | riscv64 | `d8bbe8d40b54f8256fbc2d55c963c460` | 0x66e256 | 0x67b3d8 |
| iOS | arm64 | `ff29d57a73056e61063b212fb0a4592e` | 0x46425c | – |
| Windows | x64 | – | ✗ | ✗ |
| Linux | x64 | – | ✗ | ✗ |

Notes:

* Some engine builds compile `ssl_verify_peer_cert` in a way that none of the primary patterns match (e.g. its classic prologue is removed). As a fallback, the script also contains patterns for `ssl_crypto_x509_session_verify_cert_chain`, which returns a `bool` (1 = verified) instead of `ssl_verify_result_t` (0 = ok) — hence the different `retval` for those patterns. If both functions are found in a binary, both are hooked.
* Android arm64 builds from NDK r28c ship with [LLVM machine outlining](https://github.com/android-ndk/ndk/wiki/Changelog-r28) enabled: the register-save prologue is extracted into an outlined helper function that is called via `BL`. The corresponding pattern wildcard-bytes the `BL` target so it matches both outlined (new) and inline-prologue (older) builds.
* Flutter no longer publishes Android x86 engine binaries; riscv64 is its replacement. The riscv64 engine binary is built with NDK r28c machine outlining as well, and its `.text` segment is mapped at `VA = file offset + 0x10000` (64KiB segment alignment), so `verify.py` reports the file offsets 0x65e256 and 0x66b3d8 for the offsets listed in the table above.
* The current Windows and Linux patterns only cover older engine builds. The latest Windows (`flutter_windows.dll`) and Linux (`libflutter_linux_gtk.so`) binaries are compiled differently and are not covered yet.
* The Android sample binaries for the latest engine were derived from the official maven artifacts (`io.flutter:flutter-*-release`) by stripping the debug sections, which is what the Android Gradle Plugin does when packaging release APKs. Stripping does not affect pattern matching, as only non-loaded sections are removed.

## :warning: What if this script doesn't work?

Before creating a GitHub issue, please test the following steps:

* Can you intercept HTTP requests from the demo application?
    * If not, note that Flutter apps do not use the system's proxy settings by default. This means you should use [Proxydroid on Android](https://blog.nviso.eu/2019/08/13/intercepting-traffic-from-android-flutter-applications/) and [OpenVPN on iOS](https://blog.nviso.eu/2020/06/12/intercepting-flutter-traffic-on-ios/) (or a rogue rogue access point on both). On the Android Studio AVDs, you can use `-http-proxy` when launching the emulator.
* Can you intercept HTTPS requests from the demo application?
* Have you checked if your app's flutter library is inside the libflutter_samples directory?
    * For Android: run `apktool d <YOURAPK>` and run `md5sum` on `libs/<ARCH>/libflutter.so`
    * For iOS: Extract an *unencrypted* IPA, unzip it and run `md5sum` on `Payload/Runner.app/Frameworks/Flutter.framework/Flutter`
    * Alternatively, copy `libflutter.so` or `Flutter` to the correct folder in `libflutter_samples` and run `python3 verify.py`

If you can succesfully intercept all requests from the demo app and your library is not included in the samples, please [open a GitHub issue](https://github.com/l4rm4nd/disable-flutter-tls-verification/issues) with the app in question. It is possible that the app is using additional SSL pinning plugins, so a combination of this plugin and objection / other Frida scripts may be necessary. This is outside of the scope of this project and you will have to RE yourself to identify additional pinning protections.
