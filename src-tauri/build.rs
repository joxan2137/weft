fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "engine_status",
            "engine_restart",
            "engine_logs",
            "engine_settings",
            "engine_set_settings",
            "proxy_status",
            "proxy_set_enabled",
            "proxy_refresh",
            "proxy_set_custom",
            "proxy_set_max_latency",
            "app_info",
            "open_logs",
            "save_text_file",
            "observed_system",
        ]),
    ))
    .expect("failed to run the tauri build script");
}
