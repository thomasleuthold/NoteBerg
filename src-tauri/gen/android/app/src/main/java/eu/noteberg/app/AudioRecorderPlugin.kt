package eu.noteberg.app

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.view.WindowManager
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

/*
 * Why there is no foreground service here.
 *
 * Recording is a while-you-take-notes feature: the recorder is owned by an open
 * note and the intended use is capturing audio while writing, not unattended
 * background capture. A `microphone` foreground service would buy background
 * recording at the cost of a Play Console "Foreground service permissions"
 * declaration (form plus a demo video) gating every release on Google Play
 * review, so it is deliberately out of scope.
 *
 * Instead the app keeps the screen on for the duration of a recording, which
 * keeps the process visible, so the Android 9+ background microphone
 * restriction never engages and the recording cannot be silently muted. If the
 * app is backgrounded anyway (an incoming call, a deliberate app switch), the
 * JS layer stops and saves the recording rather than letting it run silent.
 *
 * Note that WAKE_LOCK alone would NOT have worked: it keeps the CPU awake,
 * while the microphone restriction keys off process importance. A wake-locked
 * background recording runs its full length and contains silence.
 */

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = ALIAS_MICROPHONE)
    ]
)
class AudioRecorderPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    /** Preferred pipeline: AudioRecord + our DSP + MediaCodec/MediaMuxer. */
    private var engine: AudioRecorderEngine? = null
    /** Fallback used when the engine cannot start on this device. */
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
        stopAndRelease()

        val aggressiveness = invoke.getArgs().optDouble("aggressiveness", 0.0).toFloat()

        val file = File(activity.cacheDir, "rec_${System.currentTimeMillis()}.mp4")
        outputFile = file

        // Preferred: raw capture with our own DSP, so the recorded level matches
        // the Windows build instead of depending on OEM HAL tuning (F1).
        var fallbackReason: String? = null
        try {
            val eng = AudioRecorderEngine(file, aggressiveness)
            eng.start()
            engine = eng
            setKeepScreenOn(true)
            // Reported so the JS layer can log which pipeline ran. Without this
            // the only evidence is logcat, which is out of reach on a device
            // that is not plugged into a development machine — and a recording
            // made by the fallback looks exactly like one made by the engine.
            val result = JSObject()
            result.put("pipeline", "audioRecord")
            invoke.resolve(result)
            return
        } catch (e: Exception) {
            // Kept for at least one release: AudioRecord + MediaCodec +
            // MediaMuxer is hand-driven and device-sensitive, so a device it
            // does not suit must still be able to record.
            fallbackReason = e.message ?: e.toString()
            android.util.Log.w(
                "AudioRecorderPlugin",
                "AudioRecord pipeline unavailable, falling back to MediaRecorder",
                e,
            )
            engine = null
            file.delete()
        }

        try {
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
            setKeepScreenOn(true)
            val result = JSObject()
            result.put("pipeline", "mediaRecorder")
            result.put("fallbackReason", fallbackReason ?: "unknown")
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject("Failed to start recording: ${e.message}")
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        val file = outputFile
        if ((engine == null && recorder == null) || file == null) {
            invoke.reject("No active recording")
            return
        }

        try {
            // Engine stop finalizes the muxer and rethrows a capture-thread
            // failure, so a broken recording is reported rather than returned.
            val eng = engine
            if (eng != null) eng.stop() else recorder!!.stop()
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
        val eng = engine
        if (eng != null) {
            eng.pause()
            invoke.resolve()
            return
        }
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
        val eng = engine
        if (eng != null) {
            eng.resume()
            invoke.resolve()
            return
        }
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

    /**
     * Live-update the auto-gain aggressiveness without restarting capture. The
     * MediaRecorder fallback has no gain stage of its own to update, so this is
     * a no-op there (not an error) — the same shape stop()/pause() already use
     * when only one of the two pipelines applies.
     */
    @Command
    fun setAggressiveness(invoke: Invoke) {
        val aggressiveness = invoke.getArgs().optDouble("aggressiveness", 0.0).toFloat()
        engine?.setAggressiveness(aggressiveness)
        invoke.resolve()
    }

    @Command
    fun getAmplitude(invoke: Invoke) {
        // The engine reports the post-DSP peak, the same quantity the Windows
        // meter reports; MediaRecorder.maxAmplitude is the raw input peak (F6).
        val raw = engine?.getAmplitude() ?: recorder?.maxAmplitude ?: 0  // 0–32767
        val normalised = (raw / 32767.0).coerceIn(0.0, 1.0)
        val result = JSObject()
        result.put("amplitude", normalised)
        result.put("failed", engine?.hasFailed() ?: false)
        invoke.resolve(result)
    }

    @Command
    fun cancel(invoke: Invoke) {
        engine?.cancel()
        stopAndRelease()
        outputFile?.delete()
        outputFile = null
        invoke.resolve()
    }

    private fun stopAndRelease() {
        // stop()/cancel() drive the engine themselves, because they need to see
        // a capture failure; this only clears the reference.
        engine = null
        try {
            recorder?.stop()
        } catch (_: Exception) {}
        try {
            recorder?.release()
        } catch (_: Exception) {}
        recorder = null
        setKeepScreenOn(false)
    }

    /**
     * Hold the screen on while recording. The flag is owned by the window, so it
     * is released automatically if the process dies — there is no lock to leak.
     */
    private fun setKeepScreenOn(on: Boolean) {
        activity.runOnUiThread {
            if (on) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }
}
