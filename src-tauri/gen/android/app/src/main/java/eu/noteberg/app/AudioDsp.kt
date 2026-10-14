package eu.noteberg.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Kotlin port of the Rust `audio_dsp` chain (src-tauri/src/audio_dsp.rs).
 *
 * Both platforms must land at the same target loudness — that is the whole
 * point of owning the gain stage rather than leaving it to each device's HAL —
 * so **the tuning constants below must stay identical to the Rust ones**. If
 * you change one, change both.
 *
 * The design called for a single Rust implementation reached from Kotlin over
 * JNI. That needs a verified symbol export from the Tauri cdylib plus a
 * System.loadLibrary name, neither of which can be confirmed without a device
 * build; this port is the fallback the design named for exactly that case. It
 * is ~200 lines of arithmetic with no platform dependencies, and the Rust unit
 * tests document the behaviour it must match.
 *
 * Chain: high-pass 80 Hz → slow AGC (-20 dBFS RMS target) → look-ahead peak
 * limiter (-1 dBFS ceiling) → pause/resume fades.
 */
class AudioDsp(sampleRate: Int, aggressiveness: Float = 0.0f) {

    private companion object {
        const val TARGET_RMS_DB = -20.0f
        const val RMS_WINDOW_S = 0.4f
        const val BLOCK_S = 0.01f
        const val MAX_GAIN_DB = 30.0f
        const val MIN_GAIN_DB = -6.0f
        const val GAIN_RISE_DB_PER_S = 3.0f
        const val GAIN_FALL_DB_PER_S = 30.0f
        // Noise margin at aggressiveness 0.0 (today's default behaviour) and at
        // 1.0 (most aggressive). See the matching constants in audio_dsp.rs for
        // why: in steady loud noise (e.g. driving) a fixed 6 dB margin keeps
        // gain frozen well short of the target, judging speech "too close to
        // the noise" to lift further. Narrowing the margin lets the AGC keep
        // pushing gain up in exactly that case, at the cost of also lifting the
        // noise floor itself closer to speech level.
        const val NOISE_MARGIN_DB_MIN_AGGRESSIVENESS = 6.0f
        const val NOISE_MARGIN_DB_MAX_AGGRESSIVENESS = 1.5f
        const val NOISE_RISE_DB_PER_S = 1.0f
        const val NOISE_FALL_DB_PER_S = 20.0f
        const val CEILING_DB = -1.0f
        const val LOOKAHEAD_S = 0.005f
        const val LIMITER_RELEASE_S = 0.08f
        const val FADE_S = 0.005f
        const val SILENCE_DB = -120.0f
        const val HIGH_PASS_HZ = 80.0f

        fun linToDb(x: Float): Float = if (x < 1e-7f) SILENCE_DB else 20.0f * log10(x)
        fun dbToLin(db: Float): Float = 10.0f.pow(db / 20.0f)

        /** Map a 0.0-1.0 aggressiveness knob to the noise margin, linearly. */
        fun noiseMarginDb(aggressiveness: Float): Float {
            val t = aggressiveness.coerceIn(0.0f, 1.0f)
            return NOISE_MARGIN_DB_MIN_AGGRESSIVENESS +
                (NOISE_MARGIN_DB_MAX_AGGRESSIVENESS - NOISE_MARGIN_DB_MIN_AGGRESSIVENESS) * t
        }
    }

    private val sr = sampleRate.toFloat()

    // ── High-pass (2nd-order Butterworth, direct form I) ─────────────────────
    private val b0: Float
    private val b1: Float
    private val b2: Float
    private val a1: Float
    private val a2: Float
    private var x1 = 0f
    private var x2 = 0f
    private var y1 = 0f
    private var y2 = 0f

    // ── Limiter ──────────────────────────────────────────────────────────────
    private val delay: FloatArray
    private var delayPos = 0
    private var limiterGainDb = 0f
    private val limiterReleasePerSampleDb: Float
    private val ceilingLin = dbToLin(CEILING_DB)
    // Sliding-window max over `delay`, kept as sample index + |value| pairs in
    // decreasing order of value, so the window peak is always front(). Avoids
    // rescanning the whole lookahead window on every sample.
    private val windowMaxIdx: IntArray
    private val windowMaxVal: FloatArray
    private var windowMaxHead = 0
    private var windowMaxTail = 0
    // Int is enough headroom: at 48kHz this wraps after ~1.4 years of continuous audio.
    private var sampleCount = 0

    // ── AGC ──────────────────────────────────────────────────────────────────
    private var rmsAcc = 0f
    private var rmsCount = 0
    private val rmsWindow: Int
    private var rmsDb = SILENCE_DB
    private val blockLen: Int
    private var blockPos = 0
    private var gainDb = 0f
    private var gainDbPrev = 0f
    private var noiseFloorDb = SILENCE_DB
    // @Volatile: written from the Tauri command thread by setAggressiveness()
    // (the live slider), read from the capture thread inside updateGain() —
    // ensures the write is visible promptly without a lock on the hot path.
    @Volatile
    private var noiseMarginDb = noiseMarginDb(aggressiveness)

    // ── Fades ────────────────────────────────────────────────────────────────
    private val fadeLen: Int
    private var fadeInRemaining = 0

    init {
        val w0 = 2.0f * PI.toFloat() * HIGH_PASS_HZ / sr
        val cosW0 = cos(w0)
        val sinW0 = sin(w0)
        val alpha = sinW0 / sqrt(2.0f)
        val a0 = 1.0f + alpha
        b0 = ((1.0f + cosW0) / 2.0f) / a0
        b1 = (-(1.0f + cosW0)) / a0
        b2 = ((1.0f + cosW0) / 2.0f) / a0
        a1 = (-2.0f * cosW0) / a0
        a2 = (1.0f - alpha) / a0

        delay = FloatArray(maxOf(1, (LOOKAHEAD_S * sr).toInt()))
        // +1: the deque can briefly hold one entry per in-flight sample plus the incoming one.
        windowMaxIdx = IntArray(delay.size + 1)
        windowMaxVal = FloatArray(delay.size + 1)
        limiterReleasePerSampleDb = (abs(CEILING_DB) + MAX_GAIN_DB) / (LIMITER_RELEASE_S * sr)
        rmsWindow = maxOf(1, (RMS_WINDOW_S * sr).toInt())
        blockLen = maxOf(1, (BLOCK_S * sr).toInt())
        fadeLen = maxOf(1, (FADE_S * sr).toInt())
    }

    /** Arm a fade-in; call on resume so the splice is not a step. */
    fun beginFadeIn() {
        fadeInRemaining = fadeLen
    }

    /**
     * Update the noise margin live, from a 0.0-1.0 aggressiveness value.
     * Safe to call mid-recording: the new margin is picked up at the next
     * block boundary, same as any other gain recomputation.
     */
    fun setAggressiveness(aggressiveness: Float) {
        noiseMarginDb = noiseMarginDb(aggressiveness)
    }

    /** Test-only: the Rust mirror asserts directly on private DspState fields
     * via `super::*` in the same file; JVM visibility needs an explicit hook. */
    internal fun debugGainDb(): Float = gainDb

    /** Test-only, see [debugGainDb]. */
    internal fun debugSetNoiseFloorDb(value: Float) {
        noiseFloorDb = value
    }

    /** Test-only, see [debugGainDb]. */
    internal fun debugSetRmsDb(value: Float) {
        rmsDb = value
    }

    /** Apply a fade-out to the last [fadeLen] samples of [samples]. */
    fun applyFadeOut(samples: FloatArray, length: Int) {
        val n = minOf(fadeLen, length)
        if (n <= 0) return
        val start = length - n
        for (i in 0 until n) {
            samples[start + i] *= 1.0f - i.toFloat() / n.toFloat()
        }
    }

    /**
     * Run the chain over [length] samples of [samples], in place.
     * @return the output peak, for the level meter.
     */
    fun process(samples: FloatArray, length: Int): Float {
        var peak = 0f

        for (i in 0 until length) {
            val x = highPass(samples[i])

            // Level estimate is pre-gain, so the AGC measures the input.
            rmsAcc += x * x
            rmsCount++
            if (rmsCount >= rmsWindow) {
                rmsDb = linToDb(sqrt(rmsAcc / rmsCount))
                rmsAcc = 0f
                rmsCount = 0
            }

            if (blockPos == 0) updateGain()

            val t = blockPos.toFloat() / blockLen.toFloat()
            val gDb = gainDbPrev + (gainDb - gainDbPrev) * t
            var y = x * dbToLin(gDb)

            blockPos++
            if (blockPos >= blockLen) blockPos = 0

            if (fadeInRemaining > 0) {
                val done = fadeLen - fadeInRemaining
                y *= done.toFloat() / fadeLen.toFloat()
                fadeInRemaining--
            }

            val out = limit(y)
            samples[i] = out
            val a = abs(out)
            if (a > peak) peak = a
        }

        return peak
    }

    private fun highPass(x: Float): Float {
        val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
        return y
    }

    private fun limit(x: Float): Float {
        val out = delay[delayPos]
        delay[delayPos] = x
        delayPos = (delayPos + 1) % delay.size

        // Drop entries that fell out of the window, then entries the new
        // sample outranks (they can never be the max again), then push it.
        val windowStart = sampleCount - delay.size + 1
        while (windowMaxHead != windowMaxTail && windowMaxIdx[windowMaxHead] < windowStart) {
            windowMaxHead = (windowMaxHead + 1) % windowMaxIdx.size
        }
        val a = abs(x)
        while (windowMaxHead != windowMaxTail) {
            val prevTail = (windowMaxTail - 1 + windowMaxIdx.size) % windowMaxIdx.size
            if (windowMaxVal[prevTail] > a) break
            windowMaxTail = prevTail
        }
        windowMaxIdx[windowMaxTail] = sampleCount
        windowMaxVal[windowMaxTail] = a
        windowMaxTail = (windowMaxTail + 1) % windowMaxIdx.size
        sampleCount++

        val windowPeak = windowMaxVal[windowMaxHead]
        val requiredDb =
            if (windowPeak > ceilingLin) linToDb(ceilingLin) - linToDb(windowPeak) else 0f

        limiterGainDb = if (requiredDb < limiterGainDb) {
            requiredDb
        } else {
            minOf(limiterGainDb + limiterReleasePerSampleDb, minOf(requiredDb, 0f))
        }

        return out * dbToLin(limiterGainDb)
    }

    private fun updateGain() {
        val blockDt = blockLen.toFloat() / sr

        if (rmsDb < noiseFloorDb) {
            noiseFloorDb = maxOf(noiseFloorDb - NOISE_FALL_DB_PER_S * blockDt, rmsDb)
        } else {
            noiseFloorDb = minOf(noiseFloorDb + NOISE_RISE_DB_PER_S * blockDt, rmsDb)
        }

        gainDbPrev = gainDb

        // Freeze on silence and on room tone, so the AGC does not drive its
        // +30 dB into the noise floor between phrases and produce hiss.
        if (rmsDb <= SILENCE_DB || rmsDb < noiseFloorDb + noiseMarginDb) return

        val desired = (TARGET_RMS_DB - rmsDb).coerceIn(MIN_GAIN_DB, MAX_GAIN_DB)
        gainDb = if (desired > gainDb) {
            minOf(gainDb + GAIN_RISE_DB_PER_S * blockDt, desired)
        } else {
            maxOf(gainDb - GAIN_FALL_DB_PER_S * blockDt, desired)
        }
    }
}
