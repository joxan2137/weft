use std::error::Error;
use std::fmt::Display;
use std::time::Duration;

use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::applog;

pub const MAIN: &str = "main";
const OFF_SCREEN_X: i32 = -20_000;
/// Shows the window even when the page never reports that it finished loading.
const SHOW_FALLBACK: Duration = Duration::from_secs(5);

/// `WEFT_QA_BACKGROUND=1` (tools/e2e-release.mjs): the window renders off-screen and never takes
/// focus, so a test run cannot pull the user out of a fullscreen game.
pub fn qa_background() -> bool {
    std::env::var_os("WEFT_QA_BACKGROUND").is_some_and(|value| value == "1")
}

/// Builds the main window from tauri.conf.json (where it is `create: false`, hidden until the
/// page has painted).
pub fn create_main(app: &AppHandle, background: bool) -> Result<(), Box<dyn Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
        .ok_or("tauri.conf.json has no main window")?;
    let config = if background { in_background(config) } else { config };
    let window = WebviewWindowBuilder::from_config(app, &config)?.build()?;
    disable_browser_keys(&window)?;
    if background {
        show_off_screen(&window)?;
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SHOW_FALLBACK).await;
            reveal(&app);
        });
    }
    Ok(())
}

pub fn reveal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN)
        && !window.is_visible().unwrap_or(true)
    {
        let _ = window.show();
    }
}

/// Stays hidden until `show_off_screen` has moved it: tao drops a starting position that lies
/// outside every monitor and would open it on screen.
fn in_background(mut config: WindowConfig) -> WindowConfig {
    config.center = false;
    config.prevent_overflow = None;
    config.focus = false;
    config.focusable = false;
    config.skip_taskbar = true;
    config.visible = false;
    config
}

/// Moves and shows the window in one step that never activates it, so the page renders where no
/// screen shows it. The frame is recalculated as tao's own show does, or the borderless window
/// keeps a caption's height of empty frame above the page.
#[cfg(windows)]
fn show_off_screen(window: &WebviewWindow) -> Result<(), Box<dyn Error>> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetWindowPos,
    };

    let flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW;
    unsafe { SetWindowPos(window.hwnd()?, None, OFF_SCREEN_X, 0, 0, 0, flags)? };
    Ok(())
}

#[cfg(not(windows))]
fn show_off_screen(window: &WebviewWindow) -> Result<(), Box<dyn Error>> {
    window.set_position(tauri::PhysicalPosition::new(OFF_SCREEN_X, 0))?;
    window.show()?;
    Ok(())
}

/// Keeps the editing keys and Weft's own shortcuts, and drops the browser's: reload, print,
/// find, save page, caret browsing, history navigation.
#[cfg(windows)]
fn disable_browser_keys(window: &WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    window.with_webview(|webview| {
        let disabled = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false))
        };
        if let Err(error) = disabled {
            applog::line("weft", format!("could not turn off the browser keys: {error}"));
        }
    })
}

#[cfg(not(windows))]
fn disable_browser_keys(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

/// Without a window there is nowhere else to say why Weft closed.
pub fn report_startup_failure(error: &dyn Display, background: bool) -> ! {
    applog::line("weft", format!("could not start: {error}"));
    if !background {
        show_error(&format!(
            "Weft could not start: {error}\n\nIf the Microsoft Edge WebView2 Runtime is missing \
             or damaged, install or repair it, then open Weft again."
        ));
    }
    std::process::exit(1);
}

#[cfg(windows)]
fn show_error(message: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    use windows::core::{HSTRING, w};

    unsafe {
        MessageBoxW(None, &HSTRING::from(message), w!("Weft"), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_error(message: &str) {
    eprintln!("{message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_main() -> WindowConfig {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == MAIN)
            .unwrap();
        serde_json::from_value(main.clone()).unwrap()
    }

    #[test]
    fn main_window_waits_for_rust_and_the_first_paint() {
        let config = configured_main();
        assert!(!config.create, "built in setup so a QA run can change it first");
        assert!(!config.visible, "shown once the page has loaded");
        assert!(config.prevent_overflow.is_some());
        assert_eq!(config.title, "Weft");
    }

    #[test]
    fn background_window_waits_hidden_and_never_takes_focus() {
        let config = in_background(configured_main());
        assert!(!config.visible && !config.focus && !config.focusable && config.skip_taskbar);
        assert!(!config.center && config.prevent_overflow.is_none());
    }
}
