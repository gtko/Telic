# @repo/desktop

Windows shell for Telic: a Tauri 2 window that loads the deployed web app. The session cookie is kept in the WebView2 profile between launches.

- Requirements: Rust (cargo), WebView2, Bun. Install with `bun install --linker hoisted` at the repo root.
- Run: `bun run dev` in this folder (`tauri dev`). The root `dev` and `build` scripts skip this app.
- Build: `bun run build` in this folder. The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`.
- App URL: set `TELIC_APP_URL` (and `TELIC_API_URL` for the API host) when building. Both are compiled into the binary. Defaults are the `telic-web` and `telic-api` workers on `gtux-prog.workers.dev`.
- Navigation: only the app and API hosts load in the window. Other http(s) links open in the default browser.
- The remote page has no IPC access: no capabilities are granted.
- Single instance. The window size and position are remembered.
- Not included: code signing, auto-update, final icon (generated from `apps/web/public/icon-512.png`).
