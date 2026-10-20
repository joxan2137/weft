mod applog;
mod commands;
mod engine;
mod observed;
mod paths;
mod settings;
mod window;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use engine::Engine;

pub fn run() {
    let context = tauri::generate_context!();
    if let Some(dir) = paths::early_log_dir(&context.config().identifier) {
        applog::init(&dir);
    }
    applog::install_panic_hook();
    let background = window::qa_background();

    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(
        move |app, _args, _cwd| {
            if !background {
                focus_main_window(app);
            }
        },
    ));
    // A QA run must not move the user's saved window onto the screen, nor save its own.
    let builder = if background {
        builder
    } else {
        builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() - StateFlags::DECORATIONS - StateFlags::VISIBLE)
                .build(),
        )
    };
    let app = builder
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_, url| stays_in_app(url))
                .build(),
        )
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            commands::engine_status,
            commands::engine_restart,
            commands::engine_logs,
            commands::engine_settings,
            commands::engine_set_settings,
            commands::app_info,
            commands::open_logs,
            commands::save_text_file,
            commands::observed_system,
        ])
        .on_page_load(move |webview, payload| {
            if !background && matches!(payload.event(), PageLoadEvent::Finished) {
                window::reveal(webview.app_handle());
            }
        })
        .setup(move |app| {
            if let Ok(dir) = app.path().app_log_dir() {
                applog::init(&dir);
            }
            applog::line("weft", format!("Weft {} starting", app.package_info().version));
            if let Err(error) = window::create_main(app.handle(), background) {
                window::report_startup_failure(&error, background);
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<Engine>().boot(handle.clone()).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<Engine>().follow_desktop(app.clone()).await;
                });
            }
        })
        .build(context);

    match app {
        Ok(app) => app.run(|app, event| {
            if let RunEvent::Exit = event {
                tauri::async_runtime::block_on(app.state::<Engine>().stop());
                applog::line("weft", "Weft closed");
            }
        }),
        Err(error) => window::report_startup_failure(&error, background),
    }
}

/// The frameless window only ever shows Weft itself: a link that reaches it opens in the browser
/// through the UI, never in place of the app. The dev server is on localhost in debug builds only.
fn stays_in_app(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") => cfg!(debug_assertions),
            _ => false,
        },
        _ => false,
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(window::MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::stays_in_app;

    #[test]
    fn navigation_stays_on_the_app_origin() {
        let allowed = [
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "tauri://localhost/",
        ];
        let blocked = [
            "https://github.com/anomalyco/opencode/issues",
            "http://127.0.0.1:4096/",
            "file:///C:/Windows/",
            "javascript:alert(1)",
        ];
        for url in allowed {
            assert!(stays_in_app(&url.parse().unwrap()), "{url} allowed");
        }
        for url in blocked {
            assert!(!stays_in_app(&url.parse().unwrap()), "{url} blocked");
        }
        let dev_server = "http://localhost:1420/?open=x".parse().unwrap();
        assert_eq!(stays_in_app(&dev_server), cfg!(debug_assertions));
    }
}
