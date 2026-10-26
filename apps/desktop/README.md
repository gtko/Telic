# @repo/desktop

Native shell for Telic on Windows, Linux and Android: a Tauri 2 window that loads the deployed web app. The session cookie is kept in the webview profile between launches.

- Requirements: Rust (cargo), WebView2, Bun. Install with `bun install --linker hoisted` at the repo root.
- Run: `bun run dev` in this folder (`tauri dev`). The root `dev` and `build` scripts skip this app.
- Build: `bun run build` in this folder. The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`.
- App URL: set `TELIC_APP_URL` (and `TELIC_API_URL` for the API host) when building. Both are compiled into the binary. Defaults are the `telic-web` and `telic-api` workers on `gtux-prog.workers.dev`.
- Navigation: only the app and API hosts load in the window. Other http(s) links open in the default browser.
- The remote page has no IPC access: no capabilities are granted.
- Desktop only: single instance, and the window size and position are remembered.
- Android: `bunx tauri android build --apk` in this folder, with `NDK_HOME` and `ANDROID_HOME` set. The Android Studio project is `src-tauri/gen/android`.
- Not included: Windows code signing, auto-update, store publishing.

## Release

`.github/workflows/desktop-release.yml` builds the Windows installer (NSIS), the Linux AppImage and `.deb`, and an Android APK, and attaches them to a GitHub release.

1. Set the new version in `package.json` in this folder. `tauri.conf.json` reads it from there.
2. Merge the change to `main`.
3. Tag the merge commit and push the tag:

   ```sh
   git tag desktop-v0.2.0
   git push origin desktop-v0.2.0
   ```

The tag must be `desktop-v` followed by the version in `package.json`, or the workflow fails. The release is created as a draft and is published when all builds pass. It is not marked as the latest release, so the `vX.Y.Z` releases of the web app stay the latest.

### Android signing

The APK is signed with the keystore in these repository secrets:

- `ANDROID_KEYSTORE_BASE64`: the `.jks` file, base64-encoded.
- `ANDROID_KEYSTORE_PASSWORD`: the password of the keystore and of the key. Do not use a backslash in it.
- `ANDROID_KEY_ALIAS`: the key alias.

Without them, the release has an unsigned APK (`*-unsigned.apk`) that Android does not install. To create the keystore once:

```sh
keytool -genkey -v -keystore telic-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias telic
base64 -w0 telic-release.jks
```

Keep the keystore outside the repository and back it up. An app signed with a lost key cannot be updated.
