package eu.noteberg.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.concurrent.thread

/**
 * Storage Access Framework handoff for backup archives.
 *
 * Android gives the app no filesystem path where it may freely write a
 * user-visible file, so Rust stages the archive in the app cache dir and this
 * plugin moves bytes between that path and a document URI the user picked:
 *
 *   createDocument(suggestedName) → { uri | null, existing }
 *                                                    ACTION_CREATE_DOCUMENT;
 *                                                    existing = picked a
 *                                                    non-empty document
 *   copyToUri(path, uri)          → { bytes, displayName }
 *                                                    cache file → document
 *   deleteDocument(uri)                              remove an abandoned document
 *   openDocument(targetPath)      → { path | null }  ACTION_OPEN_DOCUMENT, copied
 *                                                    into targetPath; or
 *                                   { path: null, error: "no-space",
 *                                     needed, available } when the copy
 *                                                    would not fit the cache
 *   getFreeSpace()                → { bytes }        usable space in the cache dir
 *
 * The byte copies run on a worker thread: commands and activity callbacks
 * arrive on the main thread, and a multi-hundred-megabyte copy there would
 * freeze the UI and trip an ANR. Rust blocks on the response regardless of
 * which thread resolves it.
 *
 * The URI is only ever held for the duration of one backup; nothing is
 * persisted, and no persistable URI permission is taken.
 */
@TauriPlugin
class BackupFilePlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        /** Headroom over the document size when staging a restore; the JS backup pre-flight uses the same rule. */
        private const val FREE_SPACE_HEADROOM = 1.2
        private const val FREE_SPACE_MIN_BYTES = 20L * 1024 * 1024
        private const val COPY_BUFFER = 1 shl 16
    }

    @Command
    fun createDocument(invoke: Invoke) {
        val args = invoke.getArgs()
        // JSObject.getString(key) returns "" (never null) for a missing key, so
        // a `?:` fallback on it never fires; the two-arg overload returns null.
        val suggestedName = args.getString("suggestedName", null) ?: "noteberg-backup.zip"
        // Also used to save a recording that could not be stored in the app.
        val mimeType = args.getString("mimeType", null) ?: "application/zip"
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, suggestedName)
        }
        startActivityForResult(invoke, intent, "onCreateDocumentResult")
    }

    @ActivityCallback
    fun onCreateDocumentResult(invoke: Invoke, result: ActivityResult) {
        val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
        val out = JSObject()
        out.put("uri", uri?.toString())
        // A freshly created document is empty. One with content is a file the
        // user chose to overwrite (some providers offer that): it must never be
        // deleted when the backup is cancelled or fails.
        out.put("existing", uri != null && documentSize(uri) > 0)
        invoke.resolve(out)
    }

    @Command
    fun copyToUri(invoke: Invoke) {
        val args = invoke.getArgs()
        val path = args.getString("path") ?: return invoke.reject("missing path")
        val uri = args.getString("uri") ?: return invoke.reject("missing uri")
        val file = File(path)
        if (!file.exists()) return invoke.reject("IO: staged archive not found")
        val target = Uri.parse(uri)

        thread(name = "noteberg-backup-copy") {
            try {
                var bytes = 0L
                // "wt": truncate — the document may pre-exist if the user chose to overwrite.
                val output = activity.contentResolver.openOutputStream(target, "wt")
                if (output == null) {
                    invoke.reject("IO: cannot open destination")
                    return@thread
                }
                output.use { out ->
                    file.inputStream().use { input ->
                        val buffer = ByteArray(COPY_BUFFER)
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            out.write(buffer, 0, n)
                            bytes += n
                        }
                        out.flush()
                    }
                }
                val out = JSObject()
                out.put("bytes", bytes)
                out.put("displayName", displayName(target))
                invoke.resolve(out)
            } catch (e: Exception) {
                invoke.reject("IO: ${e.message}")
            }
        }
    }

    @Command
    fun deleteDocument(invoke: Invoke) {
        val uri = invoke.getArgs().getString("uri") ?: return invoke.reject("missing uri")
        try {
            DocumentsContract.deleteDocument(activity.contentResolver, Uri.parse(uri))
        } catch (_: Exception) {
            // Best effort: the provider may not support deletion.
        }
        invoke.resolve()
    }

    private var pendingTargetPath: String? = null

    @Command
    fun openDocument(invoke: Invoke) {
        pendingTargetPath = invoke.getArgs().getString("targetPath")
            ?: return invoke.reject("missing targetPath")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // Providers label zips inconsistently; accept any and let the
            // archive reader decide whether it is a backup.
            type = "*/*"
            putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")
            )
        }
        startActivityForResult(invoke, intent, "onOpenDocumentResult")
    }

    @ActivityCallback
    fun onOpenDocumentResult(invoke: Invoke, result: ActivityResult) {
        val targetPath = pendingTargetPath
        pendingTargetPath = null
        val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
        val out = JSObject()
        if (uri == null || targetPath == null) {
            out.put("path", null)
            invoke.resolve(out)
            return
        }

        // Pre-flight: the whole document lands in the cache dir, so refuse now
        // rather than fail halfway through the copy. Unknown sizes are let through.
        val size = documentSize(uri)
        if (size >= 0) {
            val needed = maxOf((size * FREE_SPACE_HEADROOM).toLong(), FREE_SPACE_MIN_BYTES)
            val available = activity.cacheDir.usableSpace
            if (needed > available) {
                out.put("path", null)
                out.put("error", "no-space")
                out.put("needed", needed)
                out.put("available", available)
                invoke.resolve(out)
                return
            }
        }

        thread(name = "noteberg-restore-copy") {
            try {
                val target = File(targetPath)
                target.parentFile?.mkdirs()
                val input = activity.contentResolver.openInputStream(uri)
                if (input == null) {
                    invoke.reject("IO: cannot open selected file")
                    return@thread
                }
                input.use { src -> target.outputStream().use { dst -> src.copyTo(dst, COPY_BUFFER) } }
                out.put("path", target.absolutePath)
                out.put("bytes", target.length())
                invoke.resolve(out)
            } catch (e: Exception) {
                File(targetPath).delete()
                invoke.reject("IO: ${e.message}")
            }
        }
    }

    @Command
    fun getFreeSpace(invoke: Invoke) {
        val out = JSObject()
        out.put("bytes", activity.cacheDir.usableSpace)
        invoke.resolve(out)
    }

    /** The document's size in bytes as its provider reports it, or -1 when unknown. */
    private fun documentSize(uri: Uri): Long {
        try {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                val col = c.getColumnIndex(OpenableColumns.SIZE)
                if (col >= 0 && c.moveToFirst() && !c.isNull(col)) return c.getLong(col)
            }
        } catch (_: Exception) {
            // Fall through to the descriptor.
        }
        return try {
            activity.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: -1L
        } catch (_: Exception) {
            -1L
        }
    }

    /** The name the picker shows for the document, or null when the provider has none. */
    private fun displayName(uri: Uri): String? {
        return try {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                val col = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (col >= 0 && c.moveToFirst() && !c.isNull(col)) c.getString(col) else null
            }
        } catch (_: Exception) {
            null
        }
    }
}
