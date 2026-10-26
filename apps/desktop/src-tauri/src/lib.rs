use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const APP_URL: &str = match option_env!("TELIC_APP_URL") {
    Some(url) => url,
    None => "https://telic-web.gtux-prog.workers.dev",
};
const API_URL: &str = match option_env!("TELIC_API_URL") {
    Some(url) => url,
    None => "https://telic-api.gtux-prog.workers.dev",
};

fn host_of(url: &str) -> Option<String> {
    Url::parse(url).ok()?.host_str().map(str::to_owned)
}

fn is_internal(url: &Url, allowed: &[Option<String>]) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url
            .host_str()
            .is_some_and(|host| allowed.iter().flatten().any(|a| a == host))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build());
    builder
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let allowed = [host_of(APP_URL), host_of(API_URL)];
            let handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(APP_URL.parse().expect("invalid TELIC_APP_URL")),
            );
            #[cfg(desktop)]
            let window = window
                .title("Telic")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0);
            window
                .on_navigation(move |url| {
                    if is_internal(url, &allowed) {
                        return true;
                    }
                    if matches!(url.scheme(), "https" | "http") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Telic");
}
