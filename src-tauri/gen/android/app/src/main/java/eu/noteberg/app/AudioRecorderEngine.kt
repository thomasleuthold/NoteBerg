package eu.noteberg.app

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Raw-capture recording pipeline: AudioRecord → DSP → MediaCodec (AAC-LC) →
 * MediaMuxer (MP4).
 *
 * Replaces MediaRecorder's VOICE_COMMUNICATION path, where the recorded level
 * and the processing applied were entirely OEM HAL tuning — the reason one
 * device recorded at a usable level and another far too quietly, with no app-
 * side gain stage able to equalise them. VOICE_RECOGNITION asks for a flat,
 * unprocessed capture instead (no OEM AGC or noise gating on virtually all
 * devices), and [AudioDsp] then applies the same chain the Windows build uses,
 * so both platforms land at the same target loudness.
 *
 * Failure here is not fatal: [AudioRecorderPlugin] falls back to MediaRecorder
 * when [start] throws, so a device this pipeline does not suit still records.
 */
class AudioRecorderEngine(private val outputFile: File, private val initialAggressiveness: Float = 0.0f) {

    private var record: AudioRecord? = null
    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var captureThread: Thread? = null

    private val running = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)
    /** Post-DSP peak as a 0–32767 integer, matching MediaRecorder.maxAmplitude. */
    private val amplitude = AtomicInteger(0)
    /** Buffers the encoder could not accept; audio lost. Logged at stop. */
    private val dropped = AtomicInteger(0)

    @Volatile private var failure: Exception? = null

    private var agc: AutomaticGainControl? = null
    private var noiseSuppressor: NoiseSuppressor? = null

    private var sampleRate = 0
    private var dsp: AudioDsp? = null

    companion object {
        private const val TAG = "AudioRecorderEngine"
        /** Preferred rate; 44100 is the only rate guaranteed on every device. */
        private val SAMPLE_RATES = intArrayOf(48_000, 44_100)
        private const val BIT_RATE = 48_000
        private const val CODEC_TIMEOUT_US = 10_000L
        /** Give up on a wedged AudioRecord rather than spin the capture thread. */
        private const val MAX_READ_ERRORS = 10
        /** Upper bound on waiting for the encoder's end-of-stream buffer. */
        private const val EOS_DRAIN_TIMEOUT_MS = 2_000L
        /** 5 ms at 48 kHz, matching AudioDsp's fade length. */
        private const val FADE_SAMPLES_AT_48K = 240
    }

    fun start() {
        try {
            startInternal()
        } catch (e: Exception) {
            // A throw from MediaCodec or MediaMuxer would otherwise leave the
            // AudioRecord open, holding the microphone until GC — and the
            // MediaRecorder fallback would then fail to acquire it.
            cancel()
            throw e
        }
    }

    private fun startInternal() {
        val (rec, rate) = openAudioRecord()
        sampleRate = rate
        record = rec
        dsp = AudioDsp(rate, initialAggressiveness)

        // VOICE_RECOGNITION should already bypass these, but some OEMs attach
        // them anyway; our own chain is the only gain stage we want.
        disablePlatformEffects(rec.audioSessionId)

        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
        }
        val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        enc.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        enc.start()
        codec = enc

        muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

        running.set(true)
        rec.startRecording()
        captureThread = thread(name = "noteberg-audio-capture") { captureLoop() }
    }

    /**
     * Try each candidate rate; only 44.1 kHz is guaranteed to be supported for
     * capture on every device, so 48 kHz is an attempt, not an assumption.
     */
    private fun openAudioRecord(): Pair<AudioRecord, Int> {
        var lastError: Exception? = null
        for (rate in SAMPLE_RATES) {
            try {
                val minBuf = AudioRecord.getMinBufferSize(
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                )
                if (minBuf <= 0) continue
                val rec = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    // 4x the minimum: headroom so a scheduling hiccup on the
                    // capture thread does not drop buffers.
                    minBuf * 4,
                )
                if (rec.state == AudioRecord.STATE_INITIALIZED) return rec to rate
                rec.release()
            } catch (e: Exception) {
                lastError = e
            }
        }
        throw IllegalStateException("AudioRecord unavailable at any sample rate", lastError)
    }

    private fun disablePlatformEffects(sessionId: Int) {
        try {
            if (AutomaticGainControl.isAvailable()) {
                agc = AutomaticGainControl.create(sessionId)?.apply { enabled = false }
            }
        } catch (_: Exception) {}
        try {
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(sessionId)?.apply { enabled = false }
            }
        } catch (_: Exception) {}
    }

    private fun captureLoop() {
        val rec = record ?: return
        val enc = codec ?: return
        val chunk = 1024
        val pcm = ShortArray(chunk)
        val floats = FloatArray(chunk)
        val bufferInfo = MediaCodec.BufferInfo()
        var trackIndex = -1
        var muxerStarted = false
        // Timestamps derive from samples encoded, not the wall clock, so a
        // pause splices seamlessly instead of leaving a gap.
        var samplesEncoded = 0L
        var wasPaused = false
        var consecutiveReadErrors = 0

        try {
            while (running.get()) {
                if (paused.get()) {
                    if (!wasPaused) {
                        wasPaused = true
                        // Fade the audio already queued, so the cut into the
                        // pause is not a step discontinuity (a click).
                        samplesEncoded += flushFadeTail(enc, samplesEncoded)
                    }
                    // Keep reading and discarding. AudioRecord goes on filling
                    // its buffer whether or not we read, so sleeping here would
                    // mean the first reads after a resume return up to a whole
                    // buffer of audio captured *during* the pause, spliced in
                    // as if it were live.
                    val discarded = rec.read(pcm, 0, chunk)
                    if (discarded < 0 && ++consecutiveReadErrors >= MAX_READ_ERRORS) {
                        throw IllegalStateException("AudioRecord.read failed $discarded")
                    }
                    if (discarded > 0) consecutiveReadErrors = 0 else Thread.sleep(10)
                    continue
                }

                val read = rec.read(pcm, 0, chunk)
                if (read <= 0) {
                    // A persistent negative return (ERROR_INVALID_OPERATION,
                    // ERROR_DEAD_OBJECT) would otherwise spin this thread at
                    // full CPU until stop, recording nothing and reporting
                    // nothing.
                    if (read < 0 && ++consecutiveReadErrors >= MAX_READ_ERRORS) {
                        throw IllegalStateException("AudioRecord.read failed $read")
                    }
                    if (read < 0) Thread.sleep(5)
                    continue
                }
                consecutiveReadErrors = 0

                for (i in 0 until read) floats[i] = pcm[i] / 32768f
                if (wasPaused) {
                    dsp?.beginFadeIn()
                    wasPaused = false
                }
                val peak = dsp?.process(floats, read) ?: 0f
                amplitude.set((peak * 32767f).toInt().coerceIn(0, 32767))
                for (i in 0 until read) {
                    pcm[i] = (floats[i] * 32767f).toInt().coerceIn(-32768, 32767).toShort()
                }

                val inIndex = enc.dequeueInputBuffer(CODEC_TIMEOUT_US)
                if (inIndex >= 0) {
                    val inBuf = enc.getInputBuffer(inIndex)
                    inBuf?.clear()
                    inBuf?.asShortBuffer()?.put(pcm, 0, read)
                    val ptsUs = samplesEncoded * 1_000_000L / sampleRate
                    enc.queueInputBuffer(inIndex, 0, read * 2, ptsUs, 0)
                    samplesEncoded += read
                } else {
                    // The encoder had no free input buffer: this audio is lost.
                    // Counted and logged at stop, like the Windows ring overrun
                    // counter — a silent drop is the failure mode that made the
                    // original in-callback design so hard to diagnose.
                    dropped.incrementAndGet()
                }

                // Drain whatever the encoder has ready.
                var outIndex = enc.dequeueOutputBuffer(bufferInfo, 0)
                while (outIndex >= 0) {
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        // Codec config goes into the track format, not the stream.
                        bufferInfo.size = 0
                    }
                    if (bufferInfo.size > 0 && muxerStarted) {
                        val outBuf: ByteBuffer? = enc.getOutputBuffer(outIndex)
                        if (outBuf != null) {
                            outBuf.position(bufferInfo.offset)
                            outBuf.limit(bufferInfo.offset + bufferInfo.size)
                            muxer?.writeSampleData(trackIndex, outBuf, bufferInfo)
                        }
                    }
                    enc.releaseOutputBuffer(outIndex, false)
                    outIndex = enc.dequeueOutputBuffer(bufferInfo, 0)
                }
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED && !muxerStarted) {
                    trackIndex = muxer!!.addTrack(enc.outputFormat)
                    muxer!!.start()
                    muxerStarted = true
                }
            }

            // Flush the encoder so the tail of the recording is not lost.
            val inIndex = enc.dequeueInputBuffer(CODEC_TIMEOUT_US)
            if (inIndex >= 0) {
                enc.queueInputBuffer(
                    inIndex,
                    0,
                    0,
                    samplesEncoded * 1_000_000L / sampleRate,
                    MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                )
            }
            // Drain until the end-of-stream buffer actually arrives.
            // INFO_TRY_AGAIN_LATER is not a terminator — treating it as one
            // (any negative value ending a `while (outIndex >= 0)` loop) drops
            // the tail of the recording whenever the encoder is briefly busy.
            val drainDeadline = System.currentTimeMillis() + EOS_DRAIN_TIMEOUT_MS
            while (System.currentTimeMillis() < drainDeadline) {
                val outIndex = enc.dequeueOutputBuffer(bufferInfo, CODEC_TIMEOUT_US)
                if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) continue
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    if (!muxerStarted) {
                        trackIndex = muxer!!.addTrack(enc.outputFormat)
                        muxer!!.start()
                        muxerStarted = true
                    }
                    continue
                }
                if (outIndex < 0) continue

                if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                    bufferInfo.size = 0
                }
                if (bufferInfo.size > 0 && muxerStarted) {
                    val outBuf = enc.getOutputBuffer(outIndex)
                    if (outBuf != null) {
                        outBuf.position(bufferInfo.offset)
                        outBuf.limit(bufferInfo.offset + bufferInfo.size)
                        muxer?.writeSampleData(trackIndex, outBuf, bufferInfo)
                    }
                }
                val eos = bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                enc.releaseOutputBuffer(outIndex, false)
                if (eos) break
            }
        } catch (e: Exception) {
            // Reported at stop(): the capture thread has no caller to throw to.
            failure = e
            android.util.Log.e(TAG, "capture loop failed", e)
        }
    }

    /**
     * Fade out whatever the encoder has not yet been given, so the audio before
     * a pause ends at silence instead of cutting mid-waveform.
     *
     * The DSP's own fade is applied to a short silent tail queued here: by the
     * time a pause is observed, the pre-pause audio has already been encoded,
     * so the fade can only be applied to what follows it.
     *
     * @return the number of samples queued, which the caller must add to its
     *   sample count so the next buffer's timestamp follows this one.
     */
    private fun flushFadeTail(enc: MediaCodec, samplesEncoded: Long): Int {
        val d = dsp ?: return 0
        val fade = FloatArray(FADE_SAMPLES_AT_48K * sampleRate / 48_000)
        if (fade.isEmpty()) return 0
        // Ramp the DSP's trailing state down rather than appending silence:
        // process a zero-filled block so the limiter and gain settle, then fade.
        d.process(fade, fade.size)
        d.applyFadeOut(fade, fade.size)
        val out = ShortArray(fade.size) {
            (fade[it] * 32767f).toInt().coerceIn(-32768, 32767).toShort()
        }
        val inIndex = enc.dequeueInputBuffer(CODEC_TIMEOUT_US)
        if (inIndex < 0) return 0
        val inBuf = enc.getInputBuffer(inIndex)
        inBuf?.clear()
        inBuf?.asShortBuffer()?.put(out, 0, out.size)
        val ptsUs = samplesEncoded * 1_000_000L / sampleRate
        enc.queueInputBuffer(inIndex, 0, out.size * 2, ptsUs, 0)
        return out.size
    }

    fun pause() {
        paused.set(true)
    }

    fun resume() {
        paused.set(false)
    }

    /** Live-update the auto-gain aggressiveness without restarting capture. */
    fun setAggressiveness(aggressiveness: Float) {
        dsp?.setAggressiveness(aggressiveness)
    }

    fun getAmplitude(): Int = if (paused.get()) 0 else amplitude.get()

    /** Whether the capture thread has hit an unrecoverable failure. */
    fun hasFailed(): Boolean = failure != null

    /**
     * Stop, finalize the MP4 and release everything.
     * @throws Exception if the capture thread failed; the file is then unusable.
     */
    fun stop() {
        running.set(false)
        captureThread?.join(5_000)
        captureThread = null

        try {
            record?.stop()
        } catch (_: Exception) {}
        record?.release()
        record = null

        try {
            codec?.stop()
        } catch (_: Exception) {}
        codec?.release()
        codec = null

        // Must be stopped before release, or the moov atom is never written and
        // the file is unplayable.
        try {
            muxer?.stop()
        } catch (_: Exception) {}
        try {
            muxer?.release()
        } catch (_: Exception) {}
        muxer = null

        releaseEffects()

        val lost = dropped.get()
        if (lost > 0) {
            android.util.Log.w(TAG, "$lost buffer(s) dropped: encoder could not keep up")
        }

        failure?.let { throw it }
    }

    /** Stop and discard, ignoring any capture failure. */
    fun cancel() {
        running.set(false)
        captureThread?.join(2_000)
        captureThread = null
        try {
            record?.stop()
        } catch (_: Exception) {}
        record?.release()
        record = null
        try {
            codec?.stop()
        } catch (_: Exception) {}
        codec?.release()
        codec = null
        try {
            muxer?.release()
        } catch (_: Exception) {}
        muxer = null
        releaseEffects()
    }

    private fun releaseEffects() {
        try {
            agc?.release()
        } catch (_: Exception) {}
        try {
            noiseSuppressor?.release()
        } catch (_: Exception) {}
        agc = null
        noiseSuppressor = null
    }
}
