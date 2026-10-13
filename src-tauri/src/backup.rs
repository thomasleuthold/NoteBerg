//! Backup archive: a zip file streamed to disk one entry at a time.
//!
//! JS owns *what* goes into the archive (src/modules/backup.js); this module
//! only knows how to write or read one entry. Every command moves at most one
//! entry across the IPC boundary — one note's JSON as a string, or one media
//! blob as base64 — so neither side ever holds the whole archive in memory.
//!
//! Password protection is WinZip AES-256. Legacy ZipCrypto is never used: it
//! is trivially broken and would make the password feature misleading. The
//! manifest entry is always written unencrypted so the restore UI can show
//! what the file contains (counts, versions) before asking for the password.
//! It holds no note content and nothing that could help guess the password.
//!
//! Errors cross to JS as strings prefixed with a stable code
//! (`WRONG_PASSWORD`, `NOT_A_ZIP`, …) that backupArchive.js maps to typed
//! errors. Nothing here ever logs entry contents.
//!
//! On Android the archive is staged in the app cache dir and handed to the
//! Storage Access Framework by BackupFilePlugin.kt (create/open document,
//! copy cache ↔ URI). The Rust side therefore always works with a plain
//! filesystem path on every platform.

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

pub const MANIFEST_NAME: &str = "manifest.json";
/// Hard ceiling for one media entry's uncompressed size (matches restore.js).
pub const MAX_ENTRY_BYTES: u64 = 1 << 30;
/// Ceiling for entries read whole as text (note and notebook JSON), which
/// become one IPC string. Matches MAX_JSON_ENTRY_BYTES in restore.js.
pub const MAX_TEXT_ENTRY_BYTES: u64 = 64 << 20;

fn err(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

// ── Writer ───────────────────────────────────────────────────────────────────

pub struct Writer {
    zip: ZipWriter<BufWriter<File>>,
    /// The destination. Untouched until finish() renames `partial` onto it.
    path: PathBuf,
    /// Where the archive is actually written while in progress.
    partial: PathBuf,
    password: Option<String>,
}

/// Sibling of `path` that the archive is written to until it is complete.
///
/// The user may pick an existing backup as the destination. Writing straight
/// to it would truncate that file at once, and a failed or cancelled run would
/// then leave it destroyed. A sibling in the same directory keeps the final
/// rename on one filesystem, where it replaces the old file in a single step.
fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".partial");
    path.with_file_name(name)
}

impl Writer {
    pub fn create(path: &Path, password: Option<String>) -> Result<Self, String> {
        let partial = partial_path(path);
        let file = File::create(&partial).map_err(|e| err("IO", e))?;
        Ok(Self {
            zip: ZipWriter::new(BufWriter::new(file)),
            path: path.to_path_buf(),
            partial,
            password: password.filter(|p| !p.is_empty()),
        })
    }

    /// Open the next entry. Every entry except the manifest is encrypted when
    /// a password was given. Data follows via write_chunk(); the entry is
    /// closed by the next begin_entry() or by finish().
    pub fn begin_entry(&mut self, name: &str) -> Result<(), String> {
        // Only JSON is worth deflating. Media (PDF, JPEG, PNG, WebP, audio) is
        // already compressed; deflating it costs ~20 s per 300 MiB for nothing.
        let method = if name.ends_with(".json") {
            CompressionMethod::Deflated
        } else {
            CompressionMethod::Stored
        };
        // Media sizes are not known up front, so allow zip64 for every
        // stored entry; the JSON entries are small.
        let mut options = SimpleFileOptions::default()
            .compression_method(method)
            .large_file(method == CompressionMethod::Stored);
        if name != MANIFEST_NAME {
            if let Some(password) = &self.password {
                options = options.with_aes_encryption(AesMode::Aes256, password);
            }
        }
        self.zip.start_file(name, options).map_err(|e| err("IO", e))
    }

    /// Append bytes to the entry opened by begin_entry().
    pub fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.zip.write_all(bytes).map_err(|e| err("IO", e))
    }

    /// Write one whole entry.
    pub fn add(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.begin_entry(name)?;
        self.write_chunk(bytes)
    }

    /// Finalize the central directory and move the archive onto the
    /// destination. Returns the archive size in bytes. On failure the partial
    /// file is deleted and the destination is left as it was.
    pub fn finish(self) -> Result<u64, String> {
        let (path, partial) = (self.path, self.partial);
        let result = (|| {
            let mut inner = self.zip.finish().map_err(|e| err("IO", e))?;
            inner.flush().map_err(|e| err("IO", e))?;
            let file = inner.into_inner().map_err(|e| err("IO", e))?;
            file.sync_all().map_err(|e| err("IO", e))?;
            let bytes = file.metadata().map_err(|e| err("IO", e))?.len();
            // Closed before the rename: Windows refuses to move an open file.
            drop(file);
            // Replaces an existing file on every platform (MoveFileExW with
            // MOVEFILE_REPLACE_EXISTING on Windows).
            std::fs::rename(&partial, &path).map_err(|e| err("IO", e))?;
            Ok(bytes)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        result
    }

    /// Drop the writer and delete the partial file. A half-written archive
    /// must never be left behind looking like a valid backup, and the
    /// destination (possibly an older backup) is never touched.
    pub fn abort(self) {
        let partial = self.partial.clone();
        drop(self.zip);
        let _ = std::fs::remove_file(partial);
    }
}

// ── Reader ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub encrypted: bool,
}

pub struct Reader {
    zip: ZipArchive<File>,
    path: PathBuf,
    password: Option<String>,
    /// Staged copy (Android SAF) — deleted on close.
    temp: bool,
    /// Where a decoded entry is staged while JS reads it in chunks.
    staging_dir: PathBuf,
    /// The entry currently being served (see begin_read): its decoded bytes
    /// live in a file, not in memory, so a 300 MiB PDF costs one chunk of RAM.
    pending: Option<PendingEntry>,
}

struct PendingEntry {
    file: File,
    path: PathBuf,
}

impl Reader {
    pub fn open(path: &Path, temp: bool, staging_dir: PathBuf) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| err("IO", e))?;
        let zip = ZipArchive::new(file).map_err(|e| match e {
            ZipError::InvalidArchive(_) | ZipError::UnsupportedArchive(_) => err("NOT_A_ZIP", e),
            other => err("IO", other),
        })?;
        Ok(Self {
            zip,
            path: path.to_path_buf(),
            password: None,
            temp,
            staging_dir,
            pending: None,
        })
    }

    /// Central-directory listing. `by_index_raw` reads metadata only, so
    /// encrypted entries list without a password.
    pub fn entries(&mut self) -> Vec<EntryInfo> {
        let mut out = Vec::with_capacity(self.zip.len());
        for i in 0..self.zip.len() {
            if let Ok(entry) = self.zip.by_index_raw(i) {
                if !entry.is_file() {
                    continue;
                }
                out.push(EntryInfo {
                    name: entry.name().to_string(),
                    size: entry.size(),
                    compressed_size: entry.compressed_size(),
                    encrypted: entry.encrypted(),
                });
            }
        }
        out
    }

    /// The manifest, if present and readable without a password.
    pub fn manifest(&mut self) -> Option<String> {
        let entry = self.zip.by_name(MANIFEST_NAME).ok()?;
        if entry.encrypted() || entry.size() > 1 << 20 {
            return None;
        }
        let mut text = String::new();
        entry.take(1 << 20).read_to_string(&mut text).ok()?;
        Some(text)
    }

    /// Check the password against the first encrypted entry and keep it for
    /// subsequent reads. AES entries carry a password verifier, so a wrong
    /// password fails here without reading any data.
    pub fn unlock(&mut self, password: &str) -> Result<(), String> {
        let first_encrypted = (0..self.zip.len()).find_map(|i| {
            let e = self.zip.by_index_raw(i).ok()?;
            (e.is_file() && e.encrypted()).then(|| e.name().to_string())
        });
        if let Some(name) = first_encrypted {
            match self.zip.by_name_decrypt(&name, password.as_bytes()) {
                Ok(_) => {}
                Err(ZipError::InvalidPassword) => return Err(err("WRONG_PASSWORD", name)),
                Err(e) => return Err(err("CORRUPT", e)),
            }
        }
        self.password = Some(password.to_string());
        Ok(())
    }

    /// Read one text entry fully, bounded by MAX_TEXT_ENTRY_BYTES regardless
    /// of what the header claims.
    pub fn read(&mut self, name: &str) -> Result<Vec<u8>, String> {
        self.read_bounded(name, MAX_TEXT_ENTRY_BYTES)
    }

    fn read_bounded(&mut self, name: &str, max: u64) -> Result<Vec<u8>, String> {
        let password = self.password.clone();
        let entry = match &password {
            Some(pw) => self.zip.by_name_decrypt(name, pw.as_bytes()),
            None => self.zip.by_name(name),
        };
        let entry = entry.map_err(|e| match e {
            ZipError::FileNotFound => err("ENTRY_NOT_FOUND", name),
            ZipError::InvalidPassword => err("WRONG_PASSWORD", name),
            ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => {
                err("PASSWORD_REQUIRED", name)
            }
            other => err("CORRUPT", other),
        })?;
        if entry.size() > max {
            return Err(err("ENTRY_TOO_LARGE", name));
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| err("CORRUPT", e))?;
        if bytes.len() as u64 > max {
            return Err(err("ENTRY_TOO_LARGE", name));
        }
        Ok(bytes)
    }

    /// Decode one entry into a staging file and hold it for chunked reads.
    /// Returns its size. Bounded by MAX_ENTRY_BYTES regardless of the header.
    pub fn begin_read(&mut self, name: &str) -> Result<u64, String> {
        self.end_read();
        let password = self.password.clone();
        let entry = match &password {
            Some(pw) => self.zip.by_name_decrypt(name, pw.as_bytes()),
            None => self.zip.by_name(name),
        };
        let entry = entry.map_err(|e| match e {
            ZipError::FileNotFound => err("ENTRY_NOT_FOUND", name),
            ZipError::InvalidPassword => err("WRONG_PASSWORD", name),
            ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => {
                err("PASSWORD_REQUIRED", name)
            }
            other => err("CORRUPT", other),
        })?;
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(err("ENTRY_TOO_LARGE", name));
        }

        std::fs::create_dir_all(&self.staging_dir).map_err(|e| err("IO", e))?;
        let path = self
            .staging_dir
            .join(format!("noteberg-restore-entry-{}.bin", std::process::id()));
        let mut file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| err("IO", e))?;
        let copied = std::io::copy(&mut entry.take(MAX_ENTRY_BYTES + 1), &mut file);
        let size = match copied {
            Ok(n) if n <= MAX_ENTRY_BYTES => n,
            Ok(_) => {
                let _ = std::fs::remove_file(&path);
                return Err(err("ENTRY_TOO_LARGE", name));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                return Err(err("CORRUPT", e));
            }
        };
        self.pending = Some(PendingEntry { file, path });
        Ok(size)
    }

    /// One slice of the entry opened by begin_read(). Short at the end.
    pub fn read_chunk(&mut self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let pending = self
            .pending
            .as_mut()
            .ok_or_else(|| err("NO_SESSION", "no entry open for reading"))?;
        let size = pending.file.metadata().map_err(|e| err("IO", e))?.len();
        if offset > size {
            return Err(err("IO", "chunk offset past end of entry"));
        }
        let want = len.min(size - offset);
        let mut bytes = Vec::with_capacity(usize::try_from(want).map_err(|e| err("IO", e))?);
        pending
            .file
            .seek(SeekFrom::Start(offset))
            .map_err(|e| err("IO", e))?;
        (&mut pending.file)
            .take(want)
            .read_to_end(&mut bytes)
            .map_err(|e| err("IO", e))?;
        Ok(bytes)
    }

    /// Release the staged entry and delete its file.
    pub fn end_read(&mut self) {
        if let Some(pending) = self.pending.take() {
            drop(pending.file);
            let _ = std::fs::remove_file(pending.path);
        }
    }

    pub fn close(mut self) {
        self.end_read();
        let (path, temp) = (self.path.clone(), self.temp);
        drop(self.zip);
        if temp {
            let _ = std::fs::remove_file(path);
        }
    }
}

// ── Tauri state and commands ─────────────────────────────────────────────────

#[derive(Default)]
pub struct BackupState {
    writer: Mutex<Option<Writer>>,
    reader: Mutex<Option<Reader>>,
    /// Android: the SAF document the finished archive is copied into.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    android_target: Mutex<Option<AndroidTarget>>,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct AndroidTarget {
    uri: String,
    /// The user picked a document that already had content (an older backup
    /// they chose to overwrite). Never deleted on cancel or failure.
    existing: bool,
}

pub type SharedState = Arc<BackupState>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishResult {
    pub path: String,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct OpenResult {
    pub entries: Vec<EntryInfo>,
    pub manifest: Option<String>,
}

/// Run blocking archive work off the IPC thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| err("IO", e))?
}

fn lock<'a, T>(m: &'a Mutex<Option<T>>) -> std::sync::MutexGuard<'a, Option<T>> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub async fn backup_begin(
    state: tauri::State<'_, SharedState>,
    path: String,
    password: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut guard = lock(&state.writer);
        // Abort a leftover writer first: for the same destination it shares the
        // partial path, and aborting it after creating the new one would delete
        // the new writer's file.
        if let Some(old) = guard.take() {
            old.abort();
        }
        *guard = Some(Writer::create(Path::new(&path), password)?);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn backup_add_text(
    state: tauri::State<'_, SharedState>,
    name: String,
    text: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut guard = lock(&state.writer);
        let writer = guard.as_mut().ok_or_else(|| err("NO_SESSION", "no backup in progress"))?;
        writer.add(&name, text.as_bytes())
    })
    .await
}

/// Open a binary entry; its bytes arrive through backup_write_chunk() so one
/// large media file never becomes one huge IPC payload, and JS can honour a
/// cancel between chunks.
#[tauri::command]
pub async fn backup_begin_entry(
    state: tauri::State<'_, SharedState>,
    name: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut guard = lock(&state.writer);
        let writer = guard.as_mut().ok_or_else(|| err("NO_SESSION", "no backup in progress"))?;
        writer.begin_entry(&name)
    })
    .await
}

#[tauri::command]
pub async fn backup_write_chunk(
    state: tauri::State<'_, SharedState>,
    data_base64: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.as_bytes())
            .map_err(|e| err("IO", e))?;
        drop(data_base64);
        let mut guard = lock(&state.writer);
        let writer = guard.as_mut().ok_or_else(|| err("NO_SESSION", "no backup in progress"))?;
        writer.write_chunk(&bytes)
    })
    .await
}

#[tauri::command]
pub async fn backup_finish(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<FinishResult, String> {
    let state = state.inner().clone();
    let (path, bytes) = blocking({
        let state = state.clone();
        move || {
            let writer = lock(&state.writer)
                .take()
                .ok_or_else(|| err("NO_SESSION", "no backup in progress"))?;
            let path = writer.path.clone();
            // A finish that fails (disk full while writing the central
            // directory) deletes its partial file and leaves `path` untouched.
            let bytes = writer.finish()?;
            Ok((path, bytes))
        }
    })
    .await?;
    let path = platform::deliver_backup(&app, &state, path).await?;
    Ok(FinishResult { path, bytes })
}

#[tauri::command]
pub async fn backup_abort(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking({
        let state = state.clone();
        move || {
            if let Some(writer) = lock(&state.writer).take() {
                writer.abort();
            }
            Ok(())
        }
    })
    .await?;
    platform::discard_backup_target(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn backup_choose_destination(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    platform::choose_backup_destination(&app, state.inner(), suggested_name).await
}

#[tauri::command]
pub async fn restore_choose_source(app: tauri::AppHandle) -> Result<Option<String>, String> {
    platform::choose_restore_source(&app).await
}

#[tauri::command]
pub async fn backup_free_space(app: tauri::AppHandle) -> Result<Option<u64>, String> {
    platform::free_space(&app).await
}

#[tauri::command]
pub async fn restore_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
    path: String,
) -> Result<OpenResult, String> {
    let state = state.inner().clone();
    let temp = platform::is_staged_path(&app, Path::new(&path));
    let staging_dir = platform::staging_dir(&app)?;
    blocking(move || {
        let mut reader = Reader::open(Path::new(&path), temp, staging_dir).inspect_err(|_| {
            if temp {
                let _ = std::fs::remove_file(Path::new(&path));
            }
        })?;
        let entries = reader.entries();
        let manifest = reader.manifest();
        if let Some(old) = lock(&state.reader).replace(reader) {
            old.close();
        }
        Ok(OpenResult { entries, manifest })
    })
    .await
}

#[tauri::command]
pub async fn restore_unlock(
    state: tauri::State<'_, SharedState>,
    password: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut guard = lock(&state.reader);
        let reader = guard.as_mut().ok_or_else(|| err("NO_SESSION", "no archive open"))?;
        reader.unlock(&password)
    })
    .await
}

#[tauri::command]
pub async fn restore_read_text(
    state: tauri::State<'_, SharedState>,
    name: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut guard = lock(&state.reader);
        let reader = guard.as_mut().ok_or_else(|| err("NO_SESSION", "no archive open"))?;
        let bytes = reader.read(&name)?;
        String::from_utf8(bytes).map_err(|_| err("CORRUPT", name))
    })
    .await
}

/// Decode a binary entry and return its size; the bytes are then fetched
/// with restore_read_chunk() and released with restore_read_end().
#[tauri::command]
pub async fn restore_read_begin(
    state: tauri::State<'_, SharedState>,
    name: String,
) -> Result<u64, String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut guard = lock(&state.reader);
        let reader = guard.as_mut().ok_or_else(|| err("NO_SESSION", "no archive open"))?;
        reader.begin_read(&name)
    })
    .await
}

#[tauri::command]
pub async fn restore_read_chunk(
    state: tauri::State<'_, SharedState>,
    offset: u64,
    len: u64,
) -> Result<String, String> {
    let state = state.inner().clone();
    blocking(move || {
        let mut guard = lock(&state.reader);
        let reader = guard.as_mut().ok_or_else(|| err("NO_SESSION", "no archive open"))?;
        let chunk = reader.read_chunk(offset, len)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(chunk))
    })
    .await
}

#[tauri::command]
pub async fn restore_read_end(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        if let Some(reader) = lock(&state.reader).as_mut() {
            reader.end_read();
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn restore_close(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        if let Some(reader) = lock(&state.reader).take() {
            reader.close();
        }
        Ok(())
    })
    .await
}

// ── Platform file handoff ────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
mod platform {
    use super::*;

    pub async fn choose_backup_destination(
        _app: &tauri::AppHandle,
        _state: &BackupState,
        suggested_name: String,
    ) -> Result<Option<String>, String> {
        let handle = rfd::AsyncFileDialog::new()
            .set_file_name(&suggested_name)
            .add_filter("Backup", &["zip"])
            .save_file()
            .await;
        Ok(handle.map(|h| h.path().to_string_lossy().to_string()))
    }

    pub async fn choose_restore_source(_app: &tauri::AppHandle) -> Result<Option<String>, String> {
        let handle = rfd::AsyncFileDialog::new()
            .add_filter("Backup", &["zip"])
            .pick_file()
            .await;
        Ok(handle.map(|h| h.path().to_string_lossy().to_string()))
    }

    /// Desktop wrote straight to the chosen path; nothing to move.
    pub async fn deliver_backup(
        _app: &tauri::AppHandle,
        _state: &BackupState,
        path: PathBuf,
    ) -> Result<String, String> {
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn discard_backup_target(_app: &tauri::AppHandle, _state: &BackupState) {}

    /// Let the user save a copy of `src` (a recording that could not be stored
    /// in the app). Returns where it went, or None if the dialog was cancelled.
    pub async fn export_file(
        _app: &tauri::AppHandle,
        src: &Path,
        suggested_name: String,
        _mime_type: &str,
    ) -> Result<Option<String>, String> {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("m4a")
            .to_string();
        let handle = rfd::AsyncFileDialog::new()
            .set_file_name(&suggested_name)
            .add_filter("Audio", &[ext.as_str()])
            .save_file()
            .await;
        let Some(handle) = handle else { return Ok(None) };
        let (src, dest) = (src.to_path_buf(), handle.path().to_path_buf());
        blocking(move || {
            std::fs::copy(&src, &dest).map_err(|e| err("IO", e))?;
            Ok(Some(dest.to_string_lossy().to_string()))
        })
        .await
    }

    pub async fn free_space(_app: &tauri::AppHandle) -> Result<Option<u64>, String> {
        Ok(None)
    }

    pub fn is_staged_path(_app: &tauri::AppHandle, _path: &Path) -> bool {
        false
    }

    /// The app's own cache dir, not the shared system temp: staged entries
    /// are decrypted backup contents at a predictable name.
    pub fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        use tauri::Manager;
        app.path().app_cache_dir().map_err(|e| err("IO", e))
    }
}

#[cfg(target_os = "android")]
mod platform {
    use super::*;
    use tauri::Manager;

    pub struct BackupFilePlugin(pub tauri::plugin::PluginHandle<tauri::Wry>);

    /// Register the Kotlin BackupFilePlugin (SAF create/open + cache copy).
    pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
        tauri::plugin::Builder::<tauri::Wry>::new("backup-file")
            .setup(|app, api| {
                let handle = api.register_android_plugin("eu.noteberg.app", "BackupFilePlugin")?;
                app.manage(BackupFilePlugin(handle));
                Ok(())
            })
            .build()
    }

    /// Call into the Kotlin plugin. `run_mobile_plugin` blocks until Kotlin
    /// resolves, which for the document pickers means until the user has
    /// chosen a file, so it runs on a blocking thread rather than an async
    /// runtime worker.
    async fn call(
        app: &tauri::AppHandle,
        method: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let app = app.clone();
        let method = method.to_string();
        blocking(move || {
            app.state::<BackupFilePlugin>()
                .0
                .run_mobile_plugin::<serde_json::Value>(&method, args)
                .map_err(|e| err("IO", e))
        })
        .await
    }

    fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_cache_dir().map_err(|e| err("IO", e))?;
        std::fs::create_dir_all(&dir).map_err(|e| err("IO", e))?;
        Ok(dir)
    }

    /// Ask SAF for the destination up front (so a cancel costs nothing), keep
    /// the URI, and stage the archive in the cache dir meanwhile.
    pub async fn choose_backup_destination(
        app: &tauri::AppHandle,
        state: &BackupState,
        suggested_name: String,
    ) -> Result<Option<String>, String> {
        let result = call(
            app,
            "createDocument",
            serde_json::json!({ "suggestedName": suggested_name, "mimeType": "application/zip" }),
        )
        .await?;
        let Some(uri) = result.get("uri").and_then(|v| v.as_str()) else {
            return Ok(None);
        };
        let existing = result.get("existing").and_then(|v| v.as_bool()).unwrap_or(false);
        *lock(&state.android_target) = Some(AndroidTarget { uri: uri.to_string(), existing });
        Ok(Some(cache_dir(app)?.join(&suggested_name).to_string_lossy().to_string()))
    }

    pub async fn choose_restore_source(app: &tauri::AppHandle) -> Result<Option<String>, String> {
        let dir = cache_dir(app)?;
        let staged = dir.join(format!("restore-{}.zip", std::process::id()));
        let result = call(
            app,
            "openDocument",
            serde_json::json!({ "targetPath": staged.to_string_lossy() }),
        )
        .await?;
        // The document is copied into the cache in full; Kotlin refuses up
        // front when it would not fit. "NO_SPACE: <needed> <available>".
        if result.get("error").and_then(|v| v.as_str()) == Some("no-space") {
            let needed = result.get("needed").and_then(|v| v.as_u64()).unwrap_or(0);
            let available = result.get("available").and_then(|v| v.as_u64()).unwrap_or(0);
            return Err(format!("NO_SPACE: {needed} {available}"));
        }
        Ok(result.get("path").and_then(|v| v.as_str()).map(String::from))
    }

    /// Copy the staged archive into the SAF document, then delete the staging
    /// file — in every outcome.
    pub async fn deliver_backup(
        app: &tauri::AppHandle,
        state: &BackupState,
        path: PathBuf,
    ) -> Result<String, String> {
        let target = lock(&state.android_target).take();
        let result = match target {
            Some(AndroidTarget { uri, existing }) => {
                let copied = call(
                    app,
                    "copyToUri",
                    serde_json::json!({ "path": path.to_string_lossy(), "uri": uri }),
                )
                .await;
                match copied {
                    // The name the picker shows is what the user will look
                    // for; the content URI means nothing to them.
                    Ok(value) => Ok(value
                        .get("displayName")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .unwrap_or(uri)),
                    Err(e) => {
                        // A partial copy must not be left behind looking like a
                        // backup. An overwritten document is the exception: SAF
                        // offers no write-then-rename, so a copy that fails
                        // midway has already damaged it, but deleting it would
                        // also remove whatever the provider can still recover
                        // (version history on cloud providers).
                        if !existing {
                            let _ =
                                call(app, "deleteDocument", serde_json::json!({ "uri": uri })).await;
                        }
                        Err(e)
                    }
                }
            }
            None => Err(err("NO_SESSION", "no destination chosen")),
        };
        let _ = std::fs::remove_file(&path);
        result
    }

    /// The SAF document was created empty when chosen; remove it so a
    /// cancelled backup leaves no zero-byte file that looks like a backup.
    /// A document that already had content is the user's older backup, still
    /// intact (nothing is copied into it before finish), and is kept.
    pub async fn discard_backup_target(app: &tauri::AppHandle, state: &BackupState) {
        // Take the value out first: the guard must not live across the await.
        let target = lock(&state.android_target).take();
        if let Some(AndroidTarget { uri, existing: false }) = target {
            let _ = call(app, "deleteDocument", serde_json::json!({ "uri": uri })).await;
        }
    }

    /// Let the user save a copy of `src` (a recording that could not be stored
    /// in the app) through SAF. Returns the document's display name, or None
    /// if the picker was cancelled.
    pub async fn export_file(
        app: &tauri::AppHandle,
        src: &Path,
        suggested_name: String,
        mime_type: &str,
    ) -> Result<Option<String>, String> {
        let result = call(
            app,
            "createDocument",
            serde_json::json!({ "suggestedName": suggested_name, "mimeType": mime_type }),
        )
        .await?;
        let Some(uri) = result.get("uri").and_then(|v| v.as_str()).map(String::from) else {
            return Ok(None);
        };
        let existing = result.get("existing").and_then(|v| v.as_bool()).unwrap_or(false);
        let copied = call(
            app,
            "copyToUri",
            serde_json::json!({ "path": src.to_string_lossy(), "uri": uri }),
        )
        .await;
        match copied {
            Ok(value) => Ok(Some(
                value
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or(uri),
            )),
            Err(e) => {
                if !existing {
                    let _ = call(app, "deleteDocument", serde_json::json!({ "uri": uri })).await;
                }
                Err(e)
            }
        }
    }

    pub async fn free_space(app: &tauri::AppHandle) -> Result<Option<u64>, String> {
        let result = call(app, "getFreeSpace", serde_json::json!({})).await?;
        Ok(result.get("bytes").and_then(|v| v.as_u64()))
    }

    pub fn is_staged_path(app: &tauri::AppHandle, path: &Path) -> bool {
        cache_dir(app).map(|dir| path.starts_with(dir)).unwrap_or(false)
    }

    /// std::env::temp_dir() is not writable by an app on Android; the app
    /// cache dir is.
    pub fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        cache_dir(app)
    }
}

#[cfg(target_os = "android")]
pub use platform::plugin as android_plugin;

/// Save-a-copy handoff, reused by the recording recovery path (lib.rs).
pub use platform::export_file;

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("noteberg-backup-test-{tag}-{nanos}.zip"))
    }

    fn write_archive(path: &Path, password: Option<&str>) {
        let mut w = Writer::create(path, password.map(String::from)).unwrap();
        w.add("quickNotes/n-1.json", br#"{"id":"n-1"}"#).unwrap();
        w.add("quickNotes/n-1_media/f-1.png", &[1u8, 2, 3, 4, 5]).unwrap();
        w.add(MANIFEST_NAME, br#"{"schema":1}"#).unwrap();
        let bytes = w.finish().unwrap();
        assert!(bytes > 0);
    }

    #[test]
    fn plain_round_trip() {
        let path = temp_path("plain");
        write_archive(&path, None);

        let mut r = Reader::open(&path, true, std::env::temp_dir()).unwrap();
        let names: Vec<_> = r.entries().iter().map(|e| e.name.clone()).collect();
        assert_eq!(
            names,
            vec!["quickNotes/n-1.json", "quickNotes/n-1_media/f-1.png", MANIFEST_NAME]
        );
        assert!(r.entries().iter().all(|e| !e.encrypted));
        assert_eq!(r.manifest().unwrap(), r#"{"schema":1}"#);
        assert_eq!(r.read("quickNotes/n-1.json").unwrap(), br#"{"id":"n-1"}"#);
        assert_eq!(r.read("quickNotes/n-1_media/f-1.png").unwrap(), vec![1, 2, 3, 4, 5]);
        assert!(r.read("missing").unwrap_err().starts_with("ENTRY_NOT_FOUND"));
        r.close();
        assert!(!path.exists(), "temp archive is deleted on close");
    }

    #[test]
    fn encrypted_round_trip_keeps_manifest_readable() {
        let path = temp_path("aes");
        write_archive(&path, Some("correct horse"));

        let mut r = Reader::open(&path, false, std::env::temp_dir()).unwrap();
        let entries = r.entries();
        assert!(entries.iter().filter(|e| e.name != MANIFEST_NAME).all(|e| e.encrypted));
        assert!(!entries.iter().find(|e| e.name == MANIFEST_NAME).unwrap().encrypted);
        assert_eq!(r.manifest().unwrap(), r#"{"schema":1}"#);

        assert!(r.read("quickNotes/n-1.json").unwrap_err().starts_with("PASSWORD_REQUIRED"));
        assert!(r.unlock("wrong").unwrap_err().starts_with("WRONG_PASSWORD"));
        r.unlock("correct horse").unwrap();
        assert_eq!(r.read("quickNotes/n-1.json").unwrap(), br#"{"id":"n-1"}"#);
        assert_eq!(r.read("quickNotes/n-1_media/f-1.png").unwrap(), vec![1, 2, 3, 4, 5]);
        r.close();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn chunked_write_and_read_match_a_whole_entry() {
        let path = temp_path("chunks");
        let data: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut w = Writer::create(&path, Some("pw".into())).unwrap();
        w.begin_entry("quickNotes/n-1_media/f-1.pdf").unwrap();
        for chunk in data.chunks(30_000) {
            w.write_chunk(chunk).unwrap();
        }
        w.add(MANIFEST_NAME, b"{}").unwrap();
        w.finish().unwrap();

        let staging = std::env::temp_dir().join(format!("noteberg-staging-{}", std::process::id()));
        let mut r = Reader::open(&path, true, staging.clone()).unwrap();
        r.unlock("pw").unwrap();
        assert_eq!(r.begin_read("quickNotes/n-1_media/f-1.pdf").unwrap(), 100_000);
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 1, "entry is staged on disk");
        let mut out = Vec::new();
        let mut offset = 0u64;
        loop {
            let chunk = r.read_chunk(offset, 40_000).unwrap();
            if chunk.is_empty() {
                break;
            }
            offset += chunk.len() as u64;
            out.extend_from_slice(&chunk);
        }
        assert_eq!(out, data);
        assert!(r.read_chunk(200_000, 1).is_err());
        r.end_read();
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0, "staging file removed");
        assert!(r.read_chunk(0, 1).unwrap_err().starts_with("NO_SESSION"));
        r.close();
        let _ = std::fs::remove_dir(&staging);
    }

    #[test]
    fn text_entry_ceiling_is_enforced() {
        let path = temp_path("text-ceiling");
        let mut w = Writer::create(&path, None).unwrap();
        w.add("quickNotes/n-1.json", &[b'x'; 64]).unwrap();
        w.add(MANIFEST_NAME, b"{}").unwrap();
        w.finish().unwrap();

        let mut r = Reader::open(&path, true, std::env::temp_dir()).unwrap();
        assert_eq!(r.read_bounded("quickNotes/n-1.json", 64).unwrap().len(), 64);
        let e = r.read_bounded("quickNotes/n-1.json", 63).unwrap_err();
        assert!(e.starts_with("ENTRY_TOO_LARGE"), "{e}");
        assert!(MAX_TEXT_ENTRY_BYTES < MAX_ENTRY_BYTES);
        r.close();
    }

    #[test]
    fn empty_password_means_no_encryption() {
        let path = temp_path("empty-pw");
        write_archive(&path, Some(""));
        let mut r = Reader::open(&path, true, std::env::temp_dir()).unwrap();
        assert!(r.entries().iter().all(|e| !e.encrypted));
        r.close();
    }

    #[test]
    fn abort_deletes_the_partial_file() {
        let path = temp_path("abort");
        let mut w = Writer::create(&path, None).unwrap();
        w.add("quickNotes/n-1.json", b"{}").unwrap();
        assert!(partial_path(&path).exists(), "written to the partial file");
        assert!(!path.exists(), "destination untouched while in progress");
        w.abort();
        assert!(!partial_path(&path).exists());
        assert!(!path.exists());
    }

    #[test]
    fn aborting_over_an_existing_backup_keeps_it() {
        let path = temp_path("keep-old");
        std::fs::write(&path, b"older backup").unwrap();
        let mut w = Writer::create(&path, None).unwrap();
        w.add("quickNotes/n-1.json", b"{}").unwrap();
        w.abort();
        assert_eq!(std::fs::read(&path).unwrap(), b"older backup");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn finishing_replaces_an_existing_backup() {
        let path = temp_path("replace-old");
        std::fs::write(&path, b"older backup").unwrap();
        write_archive(&path, None);
        assert!(!partial_path(&path).exists());
        let mut r = Reader::open(&path, true, std::env::temp_dir()).unwrap();
        assert_eq!(r.manifest().unwrap(), r#"{"schema":1}"#);
        r.close();
    }

    /// Timing probe for one very large entry, run by hand:
    /// `cargo test --release --lib timing_large_entry -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn timing_large_entry() {
        let size = 300 * 1024 * 1024;
        let mut data = vec![0u8; size];
        let mut x: u32 = 12345;
        for b in data.iter_mut() {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            *b = (x >> 24) as u8;
        }
        for password in [None, Some("correct horse")] {
            let path = temp_path("timing");
            let t0 = std::time::Instant::now();
            let mut w = Writer::create(&path, password.map(String::from)).unwrap();
            w.add("quickNotes/n-1_media/big.pdf", &data).unwrap();
            let bytes = w.finish().unwrap();
            eprintln!(
                "300 MiB entry, password={:?}: {:?} ({} bytes)",
                password.is_some(),
                t0.elapsed(),
                bytes
            );
            let _ = std::fs::remove_file(&path);
        }
    }

    #[test]
    fn not_a_zip_is_distinguishable() {
        let path = temp_path("junk");
        std::fs::write(&path, b"this is not a zip file at all").unwrap();
        let e = match Reader::open(&path, false, std::env::temp_dir()) {
            Err(e) => e,
            Ok(_) => panic!("junk opened as an archive"),
        };
        assert!(e.starts_with("NOT_A_ZIP"), "{e}");
        let _ = std::fs::remove_file(&path);
    }
}
