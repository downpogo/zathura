#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod native_files;

fn can_navigate(url: &tauri::Url) -> bool {
    native_files::check_caller("main", "main", url).is_ok()
        && matches!(url.path(), "/" | "/index.html")
}

fn pdf_asset_mime(path: &str) -> Option<&'static str> {
    if !path.starts_with("/pdfjs/") {
        return None;
    }
    match path.rsplit('.').next()? {
        "bcmap" | "pfb" => Some("application/octet-stream"),
        "icc" => Some("application/vnd.iccprofile"),
        "wasm" => Some("application/wasm"),
        "ttf" => Some("font/ttf"),
        _ => None,
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(can_navigate)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_web_resource_request(|request, response| {
                    let Ok(url) = tauri::Url::parse(&request.uri().to_string()) else {
                        return;
                    };
                    if native_files::check_caller("main", "main", &url).is_ok() {
                        if let Some(mime) = pdf_asset_mime(url.path()) {
                            response.headers_mut().insert(
                                tauri::http::header::CONTENT_TYPE,
                                tauri::http::HeaderValue::from_static(mime),
                            );
                        }
                    }
                })
                .build()?;
            Ok(())
        })
        .manage(native_files::NativeFiles::default())
        .invoke_handler(tauri::generate_handler![
            native_files::select_pdf_files,
            native_files::read_pdf_file,
            native_files::release_pdf_file,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start reader shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_on_the_reader_entrypoint() {
        for url in ["tauri://localhost/", "http://tauri.localhost/index.html"] {
            assert!(can_navigate(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com/",
            "file:///private.pdf",
            "http://tauri.localhost/pdfjs/LICENSE",
        ] {
            assert!(!can_navigate(&url.parse().unwrap()));
        }
    }

    #[test]
    fn pdf_asset_mime_overrides_are_narrow() {
        assert_eq!(
            pdf_asset_mime("/pdfjs/cmaps/test.bcmap"),
            Some("application/octet-stream")
        );
        assert_eq!(
            pdf_asset_mime("/pdfjs/wasm/qcms_bg.wasm"),
            Some("application/wasm")
        );
        assert_eq!(
            pdf_asset_mime("/pdfjs/iccs/profile.icc"),
            Some("application/vnd.iccprofile")
        );
        assert_eq!(
            pdf_asset_mime("/pdfjs/standard_fonts/font.ttf"),
            Some("font/ttf")
        );
        assert_eq!(pdf_asset_mime("/other/file.bcmap"), None);
        assert_eq!(pdf_asset_mime("/pdfjs/index.html"), None);
    }
}
