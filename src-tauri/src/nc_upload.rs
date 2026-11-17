//! Uploads into the signed-in user's own Nextcloud files, with the body passed
//! over IPC as raw bytes.
//!
//! The HTTP plugin's `fetch` sends a request body as a JSON array of numbers
//! (`Array.from(new Uint8Array(body))` on the JS side), one number per byte.
//! Uploading a 1.3 MB note that way blocked the WebView's main thread for about
//! 1.5 s, while the user writes. Here the body arrives as `InvokeBody::Raw` (the
//! JS side passes a `Uint8Array`), with no JSON at all.
//!
//! Android's IPC cannot carry a raw body (the WebView does not expose a request
//! body to the custom protocol, so Tauri always uses postMessage there). The JS
//! side then passes the bytes as one base64 string, which arrives as
//! `InvokeBody::Json(String)`: a single string value, not an array of numbers.
//!
//! Deliberately narrow: the WebView names only a path inside the user's own
//! WebDAV file tree (or chunked-upload area) and the upload's conditions. The
//! server, the user and the login come from the stored Nextcloud credentials
//! (the same keychain entry the app's secureStorage writes), so this cannot be
//! pointed at another host, and the password never passes through the WebView
//! for it.
//!
//! IPC headers:
//!  - `x-nb-path`: the file's path in the user's tree, each segment encoded as JS
//!    `encodeURIComponent` does (IPC header values are ASCII; a shared folder's
//!    name need not be), e.g. `/NoteBerg/notebooks/<id>/notes/<id>.json`
//!  - `x-nb-tree`: `files` (default) or `uploads`, the user's chunked-upload area
//!    (`/remote.php/dav/uploads/<user>/<session>/<n>`)
//!  - `x-nb-content-type`: the body's media type (default `application/octet-stream`)
//!  - `x-nb-if-match`: upload only over this etag (412 otherwise)
//!  - `x-nb-if-none-match`: `*`, upload only if the file does not exist
//!  - `x-nb-mtime`: modification time to record, in seconds

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_http::reqwest;

const CREDENTIALS_KEY: &str = "nextcloud_credentials";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    server_url: String,
    login_name: String,
    app_password: String,
    #[serde(default)]
    user_id: Option<String>,
}

#[derive(Serialize)]
pub struct NcUploadResult {
    status: u16,
    etag: Option<String>,
}

async fn credentials(app: &tauri::AppHandle) -> Result<Credentials, String> {
    #[cfg(not(target_os = "android"))]
    let stored = {
        let _ = app;
        crate::get_credential(CREDENTIALS_KEY.to_string())?
    };
    #[cfg(target_os = "android")]
    let stored = crate::get_credential(app.clone(), CREDENTIALS_KEY.to_string()).await?;
    let stored = stored.ok_or("not signed in to Nextcloud")?;
    serde_json::from_str(&stored).map_err(|e| format!("stored credentials unreadable: {e}"))
}

/// What `encodeURIComponent` leaves as it is, besides letters and digits.
const UNRESERVED: &[u8] = b"-_.!~*'()";

/// One path segment as JS `encodeURIComponent` encodes it (storagePaths.encodeDavPath).
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// One encoded segment, decoded; None when it is not `encodeURIComponent` output.
fn decode_segment(segment: &str) -> Option<Vec<u8>> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == b'%' {
            let hex = segment.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else if byte.is_ascii_alphanumeric() || UNRESERVED.contains(&byte) {
            out.push(byte);
            i += 1;
        } else {
            return None;
        }
    }
    Some(out)
}

/// An encoded path inside the user's file tree, as sent: absolute, and every
/// segment plain `encodeURIComponent` output that decodes to a name (not empty,
/// `.` or `..`, and without slash, backslash or control characters).
fn checked_path(path: &str) -> Result<String, String> {
    let rest = path.strip_prefix('/').ok_or("path must start with /")?;
    for segment in rest.split('/') {
        let name = decode_segment(segment).ok_or("path is not encoded as expected")?;
        if name.is_empty()
            || name == b"."
            || name == b".."
            || name
                .iter()
                .any(|b| *b == b'/' || *b == b'\\' || b.is_ascii_control())
        {
            return Err("path is not a plain file path".into());
        }
    }
    Ok(path.to_string())
}

fn ipc_header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// PUT the raw IPC body to a file of the signed-in user. Resolves with the
/// status and the new etag; a non-2xx status is not an error here (412 means
/// "the server moved on", and the caller merges and tries again).
#[tauri::command]
pub async fn nc_put_file(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<NcUploadResult, String> {
    let body: std::borrow::Cow<[u8]> = match request.body() {
        InvokeBody::Raw(bytes) => std::borrow::Cow::Borrowed(bytes),
        InvokeBody::Json(serde_json::Value::String(encoded)) => std::borrow::Cow::Owned(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| format!("body is not valid base64: {e}"))?,
        ),
        _ => return Err("nc_put_file expects a raw byte body or a base64 string".into()),
    };
    let path = checked_path(ipc_header(&request, "x-nb-path").ok_or("missing x-nb-path")?)?;
    let creds = credentials(&app).await?;
    if !(creds.server_url.starts_with("https://") || creds.server_url.starts_with("http://")) {
        return Err("stored server URL is not http(s)".into());
    }
    // As the JS side: the resolved user ID, else the login name
    let user = creds.user_id.as_deref().unwrap_or(&creds.login_name);
    // The user's files, or their chunked-upload area (large media are sent in pieces)
    let tree = match ipc_header(&request, "x-nb-tree").unwrap_or("files") {
        "files" => "files",
        "uploads" => "uploads",
        _ => return Err("x-nb-tree must be files or uploads".into()),
    };
    let url = format!(
        "{}/remote.php/dav/{}/{}{}",
        creds.server_url,
        tree,
        encode_segment(user),
        path
    );

    let mut put = client()
        .put(url)
        .basic_auth(&creds.login_name, Some(&creds.app_password))
        .header(
            "Content-Type",
            ipc_header(&request, "x-nb-content-type").unwrap_or("application/octet-stream"),
        )
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .body(body.into_owned());
    if let Some(etag) = ipc_header(&request, "x-nb-if-match") {
        put = put.header("If-Match", format!("\"{}\"", etag.replace('"', "")));
    } else if ipc_header(&request, "x-nb-if-none-match") == Some("*") {
        put = put.header("If-None-Match", "*");
    }
    if let Some(mtime) = ipc_header(&request, "x-nb-mtime") {
        if mtime.chars().all(|c| c.is_ascii_digit()) {
            put = put.header("X-OC-Mtime", mtime);
        }
    }

    let response = put
        .send()
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    let etag = ["etag", "oc-etag"].iter().find_map(|name| {
        response
            .headers()
            .get(*name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim_start_matches("W/").replace('"', ""))
            .filter(|v| !v.is_empty())
    });
    Ok(NcUploadResult {
        status: response.status().as_u16(),
        etag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_segments_like_encode_uri_component() {
        assert_eq!(encode_segment("a b+c"), "a%20b%2Bc");
        assert_eq!(encode_segment("ä"), "%C3%A4");
        assert_eq!(encode_segment("x-_.!~*'()y"), "x-_.!~*'()y");
    }

    #[test]
    fn accepts_only_plain_encoded_paths_in_the_tree() {
        assert_eq!(
            checked_path("/Shared_NoteBerg/M%C3%BCller/a%20b.json").unwrap(),
            "/Shared_NoteBerg/M%C3%BCller/a%20b.json"
        );
        for bad in [
            "NoteBerg/x",
            "/NoteBerg/../x",
            "/NoteBerg/%2E%2E/x",
            "/NoteBerg/%2e/x",
            "/NoteBerg//x",
            "/a/b%2Fc",
            "/a/b%5Cc",
            "/a/%00",
            "/a/b c",
            "/a/b%2",
            "/a/b\\c",
        ] {
            assert!(checked_path(bad).is_err(), "{bad}");
        }
    }
}
