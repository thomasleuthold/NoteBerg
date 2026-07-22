package eu.noteberg.app

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import androidx.core.app.ActivityCompat
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

private const val ALIAS_MICROPHONE = "microphone"

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = ALIAS_MICROPHONE)
    ]
)
class AudioRecorderPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null

    private fun hasMicPermission(): Boolean =
        ActivityCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    @Command
    fun start(invoke: Invoke) {
        // Manifest declaration alone does not grant a dangerous permission on
        // Android 6+ (API 23+); it must be requested at runtime. Without this,
        // a fresh install rejects every start() with the permission error and
        // no system dialog ever appears (M-02).
        if (!hasMicPermission()) {
            requestPermissionForAlias(ALIAS_MICROPHONE, invoke, "onMicPermissionResult")
            return
        }
        beginRecording(invoke)
    }

    /**
     * Runs after the user responds to the runtime microphone permission prompt.
     * The framework re-supplies the original [Invoke] that triggered the request.
     */
    @PermissionCallback
    fun onMicPermissionResult(invoke: Invoke) {
        if (hasMicPermission()) {
            beginRecording(invoke)
        } else {
            // Distinct code so the JS layer can show an actionable "enable the
            // microphone permission" message rather than a generic failure.
            invoke.reject("Microphone permission denied", "PERMISSION_DENIED")
        }
    }

    private fun beginRecording(invoke: Invoke) {
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

            rec.setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioSamplingRate(44100)
            rec.setAudioEncodingBitRate(32000)
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
            outputFile = null

            val result = JSObject()
            result.put("path", file.absolutePath)
            result.put("mimeType", "audio/mp4")
            invoke.resolve(result)
        } catch (e: Exception) {
            stopAndRelease()
            outputFile = null
            file.delete()
            invoke.reject("Failed to stop recording: ${e.message}")
        }
    }

    @Command
    fun pause(invoke: Invoke) {
        val rec = recorder
        if (rec == null) {
            invoke.reject("No active recording")
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                rec.pause()
                invoke.resolve()
            } else {
                invoke.reject("Pause requires Android 7.0+")
            }
        } catch (e: Exception) {
            invoke.reject("Failed to pause recording: ${e.message}")
        }
    }

    @Command
    fun resume(invoke: Invoke) {
        val rec = recorder
        if (rec == null) {
            invoke.reject("No active recording")
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                rec.resume()
                invoke.resolve()
            } else {
                invoke.reject("Resume requires Android 7.0+")
            }
        } catch (e: Exception) {
            invoke.reject("Failed to resume recording: ${e.message}")
        }
    }

    @Command
    fun getAmplitude(invoke: Invoke) {
        val raw = recorder?.maxAmplitude ?: 0  // 0–32767, resets after each call
        val normalised = (raw / 32767.0).coerceIn(0.0, 1.0)
        val result = JSObject()
        result.put("amplitude", normalised)
        invoke.resolve(result)
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
