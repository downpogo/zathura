use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Response, State, Webview};

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_HANDLES: usize = 64;
const MAX_SELECTION: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileError {
    Unauthorized,
    Busy,
    InvalidHandle,
    Missing,
    Unreadable,
    Empty,
    NotPdf,
    TooLarge,
    LimitReached,
    Internal,
}

fn io_error(error: std::io::Error) -> FileError {
    if error.kind() == std::io::ErrorKind::NotFound {
        FileError::Missing
    } else {
        FileError::Unreadable
    }
}

// Labels alone do not authorize a navigated main webview.
pub(crate) fn check_caller(label: &str, window: &str, url: &tauri::Url) -> Result<(), FileError> {
    let packaged = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);
    if label == "main"
        && window == "main"
        && url.username().is_empty()
        && url.password().is_none()
        && (packaged || development)
    {
        Ok(())
    } else {
        Err(FileError::Unauthorized)
    }
}

fn authorize(webview: &Webview) -> Result<(), FileError> {
    check_caller(
        webview.label(),
        webview.window().label(),
        &webview.url().map_err(|_| FileError::Unauthorized)?,
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedFile {
    handle: String,
    name: String,
    size: u64,
    already_open: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionFailure {
    selection_index: usize,
    error: FileError,
}

#[derive(Debug, Default, Serialize)]
pub struct Selection {
    cancelled: bool,
    files: Vec<SelectedFile>,
    errors: Vec<SelectionFailure>,
}

struct OpenFile {
    file: Mutex<File>,
    identity: same_file::Handle,
    selected: SelectedFile,
}

#[derive(Default)]
pub struct NativeFiles {
    files: Arc<Mutex<HashMap<String, Arc<OpenFile>>>>,
    selecting: Arc<AtomicBool>,
    reading: Arc<AtomicBool>,
}

struct Operation(Arc<AtomicBool>);

impl Operation {
    fn begin(flag: &Arc<AtomicBool>) -> Result<Self, FileError> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| FileError::Busy)?;
        Ok(Self(Arc::clone(flag)))
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn validate(file: &mut File) -> Result<u64, FileError> {
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(FileError::Unreadable);
    }
    let size = metadata.len();
    if size == 0 {
        return Err(FileError::Empty);
    }
    if size > MAX_FILE_BYTES {
        return Err(FileError::TooLarge);
    }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut header = [0; 5];
    if size < header.len() as u64 {
        return Err(FileError::NotPdf);
    }
    file.read_exact(&mut header).map_err(io_error)?;
    if &header != b"%PDF-" {
        return Err(FileError::NotPdf);
    }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    Ok(size)
}

impl NativeFiles {
    fn select(&self, paths: Option<Vec<PathBuf>>) -> Result<Selection, FileError> {
        let Some(paths) = paths else {
            return Ok(Selection {
                cancelled: true,
                ..Selection::default()
            });
        };
        let mut result = Selection::default();
        for (selection_index, path) in paths.into_iter().enumerate() {
            if selection_index >= MAX_SELECTION {
                // One overflow result represents all remaining unprocessed selections.
                result.errors.push(SelectionFailure {
                    selection_index,
                    error: FileError::LimitReached,
                });
                break;
            }
            let opened = (|| {
                // Avoid opening obvious directories/devices/FIFOs. Revalidate the opened object too.
                if !std::fs::metadata(&path).map_err(io_error)?.is_file() {
                    return Err(FileError::Unreadable);
                }
                let mut file = File::open(&path).map_err(io_error)?;
                let size = validate(&mut file)?;
                let identity = same_file::Handle::from_file(file.try_clone().map_err(io_error)?)
                    .map_err(io_error)?;
                let mut files = self.files.lock().map_err(|_| FileError::Internal)?;
                if let Some(existing) = files.values().find(|entry| entry.identity == identity) {
                    let mut selected = existing.selected.clone();
                    selected.already_open = true;
                    return Ok(selected);
                }
                if files.len() >= MAX_HANDLES {
                    return Err(FileError::LimitReached);
                }
                let handle = loop {
                    let candidate = uuid::Uuid::new_v4().to_string();
                    if !files.contains_key(&candidate) {
                        break candidate;
                    }
                };
                let selected = SelectedFile {
                    handle: handle.clone(),
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    size,
                    already_open: false,
                };
                files.insert(
                    handle,
                    Arc::new(OpenFile {
                        file: Mutex::new(file),
                        identity,
                        selected: selected.clone(),
                    }),
                );
                Ok(selected)
            })();
            match opened {
                Ok(selected) => result.files.push(selected),
                Err(error) => result.errors.push(SelectionFailure {
                    selection_index,
                    error,
                }),
            }
        }
        Ok(result)
    }

    fn get(&self, handle: &str) -> Result<Arc<OpenFile>, FileError> {
        self.files
            .lock()
            .map_err(|_| FileError::Internal)?
            .get(handle)
            .cloned()
            .ok_or(FileError::InvalidHandle)
    }

    fn release(&self, handle: &str) -> Result<(), FileError> {
        self.files
            .lock()
            .map_err(|_| FileError::Internal)?
            .remove(handle)
            .map(|_| ())
            .ok_or(FileError::InvalidHandle)
    }
}

#[tauri::command]
pub async fn select_pdf_files(
    webview: Webview,
    state: State<'_, NativeFiles>,
) -> Result<Selection, FileError> {
    authorize(&webview)?;
    let operation = Operation::begin(&state.selecting)?;
    let selected = rfd::AsyncFileDialog::new()
        .set_parent(&webview.window())
        .set_title("Open PDFs")
        .add_filter("PDF documents", &["pdf"])
        .pick_files()
        .await;
    // Recheck after the dialog: navigation while it was open revokes this request.
    authorize(&webview)?;
    let paths = selected.map(|files| {
        files
            .into_iter()
            .map(|file| file.path().to_owned())
            .collect()
    });
    let worker_state = NativeFiles {
        files: Arc::clone(&state.files),
        ..NativeFiles::default()
    };
    let (result, _operation) = tauri::async_runtime::spawn_blocking(move || {
        worker_state.select(paths).map(|result| (result, operation))
    })
    .await
    .map_err(|_| FileError::Internal)??;
    if let Err(error) = authorize(&webview) {
        for file in &result.files {
            if !file.already_open {
                let _ = state.release(&file.handle);
            }
        }
        return Err(error);
    }
    Ok(result)
}

#[tauri::command]
pub async fn read_pdf_file(
    webview: Webview,
    state: State<'_, NativeFiles>,
    handle: String,
) -> Result<Response, FileError> {
    authorize(&webview)?;
    let operation = Operation::begin(&state.reading)?;
    let files = Arc::clone(&state.files);
    let entry = state.get(&handle)?;
    let (bytes, _operation) = tauri::async_runtime::spawn_blocking(move || {
        read_open_file(&files, &handle, &entry).map(|bytes| (bytes, operation))
    })
    .await
    .map_err(|_| FileError::Internal)??;
    authorize(&webview)?;
    Ok(Response::new(bytes))
}

fn read_open_file(
    files: &Mutex<HashMap<String, Arc<OpenFile>>>,
    handle: &str,
    entry: &OpenFile,
) -> Result<Vec<u8>, FileError> {
    if !files
        .lock()
        .map_err(|_| FileError::Internal)?
        .contains_key(handle)
    {
        return Err(FileError::InvalidHandle);
    }
    let mut file = entry.file.lock().map_err(|_| FileError::Internal)?;
    let size = validate(&mut file)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size as usize)
        .map_err(|_| FileError::Internal)?;
    // Allocate once, with no read_to_end growth/doubling on a concurrently changed file.
    bytes.resize(size as usize, 0);
    file.read_exact(&mut bytes).map_err(io_error)?;
    let mut extra = [0; 1];
    if file.read(&mut extra).map_err(io_error)? != 0 {
        return Err(if size == MAX_FILE_BYTES {
            FileError::TooLarge
        } else {
            FileError::Unreadable
        });
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err(FileError::NotPdf);
    }
    if !files
        .lock()
        .map_err(|_| FileError::Internal)?
        .contains_key(handle)
    {
        return Err(FileError::InvalidHandle);
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn release_pdf_file(
    webview: Webview,
    state: State<'_, NativeFiles>,
    handle: String,
) -> Result<(), FileError> {
    authorize(&webview)?;
    state.release(&handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!("core03-{}", uuid::Uuid::new_v4()));
            File::create(&path).unwrap().write_all(bytes).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn authorization_checks_webview_window_and_origin() {
        let local = tauri::Url::parse("http://tauri.localhost/").unwrap();
        assert_eq!(check_caller("main", "main", &local), Ok(()));
        for url in [
            "tauri://localhost/index.html",
            "https://tauri.localhost/index.html",
        ] {
            assert_eq!(
                check_caller("main", "main", &tauri::Url::parse(url).unwrap()),
                Ok(())
            );
        }
        assert_eq!(
            check_caller(
                "main",
                "main",
                &tauri::Url::parse("http://127.0.0.1:1420/").unwrap()
            ),
            if cfg!(debug_assertions) {
                Ok(())
            } else {
                Err(FileError::Unauthorized)
            },
        );
        assert_eq!(
            check_caller("other", "main", &local),
            Err(FileError::Unauthorized)
        );
        assert_eq!(
            check_caller("main", "other", &local),
            Err(FileError::Unauthorized)
        );
        for url in [
            "https://example.com",
            "file:///private.pdf",
            "http://tauri.localhost.evil",
            "http://tauri.localhost:9000",
            "http://user@tauri.localhost",
            "http://127.0.0.1:9000",
        ] {
            assert_eq!(
                check_caller("main", "main", &tauri::Url::parse(url).unwrap()),
                Err(FileError::Unauthorized)
            );
        }
    }

    #[test]
    fn response_body_is_binary_not_json() {
        use tauri::ipc::{InvokeResponseBody, IpcResponse};
        let bytes = b"%PDF-fixture".to_vec();
        match Response::new(bytes.clone()).body().unwrap() {
            InvokeResponseBody::Raw(actual) => assert_eq!(actual, bytes),
            InvokeResponseBody::Json(_) => panic!("PDF bytes must not be JSON"),
        }
    }

    #[test]
    fn multiselect_partial_failure_cancel_and_identity_dedup() {
        let good = Fixture::new(b"%PDF-1.7\nfixture");
        let empty = Fixture::new(b"");
        let bad = Fixture::new(b"not a PDF");
        let state = NativeFiles::default();
        let result = state
            .select(Some(vec![
                good.0.clone(),
                empty.0.clone(),
                bad.0.clone(),
                good.0.with_extension("missing"),
                good.0.clone(),
            ]))
            .unwrap();
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].handle, result.files[1].handle);
        assert!(result.files[1].already_open);
        assert_eq!(
            result.errors.iter().map(|e| e.error).collect::<Vec<_>>(),
            vec![FileError::Empty, FileError::NotPdf, FileError::Missing]
        );
        assert!(state.select(None).unwrap().cancelled);
        assert_eq!(state.files.lock().unwrap().len(), 1);
    }

    #[test]
    fn read_release_and_forged_handles() {
        let good = Fixture::new(b"%PDF-1.7\nfixture");
        let state = NativeFiles::default();
        let selected = state
            .select(Some(vec![good.0.clone()]))
            .unwrap()
            .files
            .remove(0);
        let entry = state
            .files
            .lock()
            .unwrap()
            .get(&selected.handle)
            .unwrap()
            .clone();
        assert!(matches!(state.get("forged"), Err(FileError::InvalidHandle)));
        assert!(matches!(
            state.get(good.0.to_str().unwrap()),
            Err(FileError::InvalidHandle)
        ));
        assert_eq!(
            read_open_file(&state.files, &selected.handle, &entry).unwrap(),
            b"%PDF-1.7\nfixture"
        );
        assert_eq!(
            state.release(good.0.to_str().unwrap()),
            Err(FileError::InvalidHandle)
        );
        assert_eq!(state.release("forged"), Err(FileError::InvalidHandle));
        state.release(&selected.handle).unwrap();
        assert_eq!(
            read_open_file(&state.files, &selected.handle, &entry),
            Err(FileError::InvalidHandle)
        );
        assert_eq!(
            state.release(&selected.handle),
            Err(FileError::InvalidHandle)
        );
    }

    #[test]
    fn release_does_not_wait_for_an_outstanding_file_read() {
        let good = Fixture::new(b"%PDF-1.7\nfixture");
        let state = NativeFiles::default();
        let selected = state
            .select(Some(vec![good.0.clone()]))
            .unwrap()
            .files
            .remove(0);
        let entry = state.get(&selected.handle).unwrap();
        let locked_file = entry.file.lock().unwrap();
        let files = Arc::clone(&state.files);
        let handle = selected.handle.clone();
        let reading_entry = Arc::clone(&entry);
        let worker = std::thread::spawn(move || read_open_file(&files, &handle, &reading_entry));
        state.release(&selected.handle).unwrap();
        drop(locked_file);
        assert_eq!(worker.join().unwrap(), Err(FileError::InvalidHandle));
        assert!(state.files.lock().unwrap().is_empty());
    }

    #[test]
    fn hard_links_deduplicate_and_path_replacement_does_not_redirect_reads() {
        let good = Fixture::new(b"%PDF-original");
        let alias = Fixture(good.0.with_extension("alias"));
        let moved = Fixture(good.0.with_extension("moved"));
        std::fs::hard_link(&good.0, &alias.0).unwrap();
        let state = NativeFiles::default();
        let result = state
            .select(Some(vec![good.0.clone(), alias.0.clone()]))
            .unwrap();
        assert_eq!(result.files[0].handle, result.files[1].handle);
        std::fs::rename(&good.0, &moved.0).unwrap();
        File::create(&good.0)
            .unwrap()
            .write_all(b"%PDF-replacement")
            .unwrap();
        let selected = &result.files[0];
        let entry = state.get(&selected.handle).unwrap();
        assert_eq!(
            read_open_file(&state.files, &selected.handle, &entry).unwrap(),
            b"%PDF-original"
        );
        let replacement = state.select(Some(vec![good.0.clone()])).unwrap();
        assert_ne!(replacement.files[0].handle, selected.handle);
    }

    #[test]
    fn selection_and_live_handle_limits_are_bounded() {
        let good = Fixture::new(b"%PDF-fixture");
        let state = NativeFiles::default();
        let result = state
            .select(Some(vec![good.0.clone(); MAX_SELECTION + 2]))
            .unwrap();
        assert_eq!(result.files.len(), MAX_SELECTION);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].selection_index, MAX_SELECTION);
        assert_eq!(result.errors[0].error, FileError::LimitReached);
        let fixtures: Vec<_> = (0..MAX_HANDLES)
            .map(|_| Fixture::new(b"%PDF-fixture"))
            .collect();
        for fixture in fixtures.iter().take(MAX_HANDLES - 1) {
            assert_eq!(
                state
                    .select(Some(vec![fixture.0.clone()]))
                    .unwrap()
                    .files
                    .len(),
                1
            );
        }
        let result = state
            .select(Some(vec![fixtures.last().unwrap().0.clone()]))
            .unwrap();
        assert_eq!(result.errors[0].error, FileError::LimitReached);
        assert_eq!(state.files.lock().unwrap().len(), MAX_HANDLES);
        assert!(state.select(Some(vec![good.0.clone()])).unwrap().files[0].already_open);
        drop(state);
    }

    #[test]
    fn limits_and_unreadable_are_recoverable() {
        assert_eq!(
            io_error(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            FileError::Unreadable
        );
        let large = Fixture::new(b"%PDF-");
        File::options()
            .write(true)
            .open(&large.0)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        let state = NativeFiles::default();
        assert_eq!(
            state
                .select(Some(vec![std::env::temp_dir()]))
                .unwrap()
                .errors[0]
                .error,
            FileError::Unreadable
        );
        assert_eq!(
            state.select(Some(vec![large.0.clone()])).unwrap().errors[0].error,
            FileError::TooLarge
        );
        let flag = Arc::new(AtomicBool::new(false));
        let operation = Operation::begin(&flag).unwrap();
        assert!(matches!(Operation::begin(&flag), Err(FileError::Busy)));
        drop(operation);
        assert!(Operation::begin(&flag).is_ok());
    }

    #[test]
    fn a_selected_file_is_revalidated_before_every_read() {
        let good = Fixture::new(b"%PDF-fixture");
        let state = NativeFiles::default();
        let selected = state
            .select(Some(vec![good.0.clone()]))
            .unwrap()
            .files
            .remove(0);
        let entry = state.get(&selected.handle).unwrap();
        File::options()
            .write(true)
            .open(&good.0)
            .unwrap()
            .set_len(0)
            .unwrap();
        assert_eq!(
            read_open_file(&state.files, &selected.handle, &entry),
            Err(FileError::Empty)
        );
        File::options()
            .write(true)
            .open(&good.0)
            .unwrap()
            .write_all(b"not a PDF")
            .unwrap();
        assert_eq!(
            read_open_file(&state.files, &selected.handle, &entry),
            Err(FileError::NotPdf)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_sharing_denial_is_recoverable() {
        use std::os::windows::fs::OpenOptionsExt;
        let good = Fixture::new(b"%PDF-fixture");
        let locked = File::options()
            .read(true)
            .share_mode(0)
            .open(&good.0)
            .unwrap();
        let state = NativeFiles::default();
        let result = state.select(Some(vec![good.0.clone()])).unwrap();
        assert_eq!(result.errors[0].error, FileError::Unreadable);
        assert!(result.files.is_empty());
        drop(locked);
        assert_eq!(
            state
                .select(Some(vec![good.0.clone()]))
                .unwrap()
                .files
                .len(),
            1
        );
    }
}
