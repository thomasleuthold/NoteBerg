package eu.noteberg.app

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import androidx.core.app.ActivityCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class AudioRecorderPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    @Command
    fun start(invoke: Invoke) {
        if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            invoke.reject("RECORD_AUDIO permission not granted")
            return
        }

        try {
            stopAndRelease()

            val file = File(activity.cacheDir, "rec_${System.currentTimeMillis()}.mp4")
            outputFile = file

            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(activity)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioSamplingRate(44100)
            rec.setAudioEncodingBitRate(128000)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()

            recorder = rec
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to start recording: ${e.message}")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        val file = outputFile
        if (recorder == null || file == null) {
            invoke.reject("No active recording")
            return
        }

        try {
            recorder!!.stop()
            stopAndRelease()

            val bytes = file.readBytes()
            val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            file.delete()
            outputFile = null

            val result = JSObject()
            result.put("data", base64)
            result.put("mimeType", "audio/mp4")
            invoke.resolve(result)
        } catch (e: Exception) {
            stopAndRelease()
            invoke.reject("Failed to stop recording: ${e.message}")
        }
    }

    @Command
    fun cancel(invoke: Invoke) {
        stopAndRelease()
        outputFile?.delete()
        outputFile = null
        invoke.resolve()
    }

    private fun stopAndRelease() {
        try {
            recorder?.stop()
        } catch (_: Exception) {}
        try {
            recorder?.release()
        } catch (_: Exception) {}
        recorder = null
    }
}
