package eu.noteberg.app

import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class PdfSavePlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun openCachedPdf(invoke: Invoke) {
        val path = invoke.getArgs().getString("path")
        if (path == null) {
            invoke.reject("Missing path argument")
            return
        }

        val file = File(path)
        if (!file.exists()) {
            invoke.reject("File not found: $path")
            return
        }

        try {
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file
            )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/pdf")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to open PDF: ${e.message}")
        }
    }
}
