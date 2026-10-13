package eu.noteberg.app

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors the Rust unit tests in src-tauri/src/audio_dsp.rs.
 *
 * The Kotlin port exists so Android and Windows apply the same gain chain; that
 * only holds if both implementations behave the same, so the assertions here
 * are deliberately the same assertions, with the same thresholds. A change that
 * makes one pass and the other fail is the failure this file is here to catch.
 */
class AudioDspTest {

    private val sr = 48_000

    private fun sine(freq: Float, ampDb: Float, secs: Float): FloatArray {
        val amp = 10.0f.pow(ampDb / 20.0f)
        val n = (secs * sr).toInt()
        return FloatArray(n) { i ->
            amp * sin(2.0f * PI.toFloat() * freq * (i.toFloat() / sr))
        }
    }

    private fun rmsDb(samples: FloatArray, from: Int = 0, to: Int = samples.size): Float {
        var acc = 0.0
        for (i in from until to) acc += (samples[i] * samples[i]).toDouble()
        val mean = acc / (to - from)
        val r = sqrt(mean).toFloat()
        return if (r < 1e-7f) -120.0f else 20.0f * log10(r)
    }

    private fun peakDb(samples: FloatArray): Float {
        var p = 0f
        for (s in samples) if (abs(s) > p) p = abs(s)
        return if (p < 1e-7f) -120.0f else 20.0f * log10(p)
    }

    @Test
    fun quietInputReachesTargetWithinTenSeconds() {
        val dsp = AudioDsp(sr)
        val buf = sine(440f, -40f, 12f)
        dsp.process(buf, buf.size)

        val tail = rmsDb(buf, buf.size - sr, buf.size)
        assertTrue("tail RMS $tail dBFS should be within 3 dB of -20", abs(tail - (-20f)) <= 3.0f)
    }

    @Test
    fun quietInputNeverOvershootsTheCeiling() {
        val dsp = AudioDsp(sr)
        val buf = sine(440f, -40f, 12f)
        dsp.process(buf, buf.size)
        assertTrue("peak ${peakDb(buf)} exceeded the ceiling", peakDb(buf) <= -1.0f + 0.1f)
    }

    @Test
    fun fullScaleBurstProducesNothingAboveTheCeiling() {
        val dsp = AudioDsp(sr)
        val a = sine(440f, -30f, 1f)
        val b = sine(1000f, 0f, 0.5f)
        val c = sine(440f, -30f, 1f)
        val buf = FloatArray(a.size + b.size + c.size)
        a.copyInto(buf, 0)
        b.copyInto(buf, a.size)
        c.copyInto(buf, a.size + b.size)

        dsp.process(buf, buf.size)
        assertTrue("burst peaked at ${peakDb(buf)} dBFS", peakDb(buf) <= -1.0f + 0.1f)
    }

    @Test
    fun digitalSilenceDoesNotRaiseTheGain() {
        val dsp = AudioDsp(sr)
        val buf = FloatArray(sr * 5)
        val peak = dsp.process(buf, buf.size)
        assertEquals("silence must stay silent", 0f, peak, 1e-6f)
        for (s in buf) assertTrue(abs(s) < 1e-6f)
    }

    @Test
    fun steadyRoomToneIsNotAmplifiedToTheTarget() {
        val dsp = AudioDsp(sr)
        val buf = sine(200f, -65f, 10f)
        dsp.process(buf, buf.size)
        val tail = rmsDb(buf, buf.size - sr, buf.size)
        assertTrue("room tone was lifted to $tail dBFS", tail < -30.0f)
    }

    @Test
    fun aStepUpInLevelNeverExceedsTheCeiling() {
        val quiet = sine(440f, -40f, 3f)
        val loud = sine(440f, -10f, 3f)
        val buf = FloatArray(quiet.size + loud.size)
        quiet.copyInto(buf, 0)
        loud.copyInto(buf, quiet.size)

        AudioDsp(sr).process(buf, buf.size)
        assertTrue("step transition peaked at ${peakDb(buf)} dBFS", peakDb(buf) <= -1.0f + 0.1f)
    }

    @Test
    fun highPassRemovesADcOffset() {
        val dsp = AudioDsp(sr)
        val buf = FloatArray(sr) { 0.5f }
        dsp.process(buf, buf.size)
        for (i in buf.size - 1000 until buf.size) {
            assertTrue("DC offset survived the high-pass", abs(buf[i]) < 0.01f)
        }
    }

    @Test
    fun gainChangesAreSmoothEnoughToAvoidZipperNoise() {
        val dsp = AudioDsp(sr)
        val buf = sine(440f, -40f, 6f)
        dsp.process(buf, buf.size)

        // Skip the first 50 ms: the high-pass settles from zero state there, a
        // filter artifact rather than gain movement (same skip as the Rust test).
        val block = sr / 100
        var prev: Float? = null
        var i = block * 5
        while (i + block <= buf.size) {
            val level = rmsDb(buf, i, i + block)
            if (level > -120f) {
                prev?.let {
                    assertTrue(
                        "envelope jumped ${level - it} dB between 10 ms blocks",
                        abs(level - it) < 0.5f,
                    )
                }
                prev = level
            }
            i += block
        }
    }

    @Test
    fun fadeOutRampsTheTailToZero() {
        val dsp = AudioDsp(sr)
        val fadeLen = (0.005f * sr).toInt()
        val buf = FloatArray(fadeLen * 2) { 1.0f }
        dsp.applyFadeOut(buf, buf.size)

        assertEquals("samples before the fade are untouched", 1.0f, buf[0], 1e-6f)
        assertTrue("tail must reach ~zero", buf[buf.size - 1] < 0.01f)
        for (i in fadeLen until buf.size - 1) {
            assertTrue("fade must decrease monotonically", buf[i + 1] <= buf[i])
        }
    }

    @Test
    fun fadeInStartsFromSilenceAfterAResume() {
        val dsp = AudioDsp(sr)
        dsp.beginFadeIn()
        val buf = sine(440f, -20f, 0.05f)
        dsp.process(buf, buf.size)
        assertTrue("resume must not step from silence", abs(buf[0]) < 1e-3f)
    }

    /**
     * A speech burst riding on continuous, steady road/engine noise, preceded
     * by a noise-only gap (as between words) so the noise-floor tracker has
     * actually learned the noise level rather than the noise+speech blend.
     * Close enough to the noise that the default 6 dB margin freezes gain
     * before it reaches the speech target — the reported problem.
     *
     * The noise floor is seeded directly at [noiseDb] via debugSetNoiseFloorDb
     * rather than reached by processing a lead-in: the rise side of the
     * tracker deliberately moves at only 1 dB/s, so converging it from silence
     * up to a loud noise bed by simulation alone would need well over a minute
     * of audio per test.
     */
    private fun noiseGapThenSpeechBurst(
        noiseDb: Float,
        speechDb: Float,
        gapSecs: Float,
        speechSecs: Float,
    ): FloatArray {
        val gap = sine(120f, noiseDb, gapSecs)
        val noiseDuringSpeech = sine(120f, noiseDb, speechSecs)
        val speech = sine(440f, speechDb, speechSecs)
        val out = FloatArray(gap.size + noiseDuringSpeech.size)
        gap.copyInto(out, 0)
        for (i in noiseDuringSpeech.indices) {
            out[gap.size + i] = noiseDuringSpeech[i] + speech[i]
        }
        return out
    }

    // The scenario the aggressiveness setting exists to fix: at aggressiveness
    // 0.0 (today's shipped default), gain must stay frozen because speech sits
    // within the old 6 dB margin of the noise floor.
    @Test
    fun leastAggressiveFreezesGainWhenSpeechIsCloseToNoise() {
        val dsp = AudioDsp(sr, 0.0f)
        dsp.debugSetNoiseFloorDb(-30.0f)
        dsp.debugSetRmsDb(-30.0f)
        val buf = noiseGapThenSpeechBurst(-30f, -27f, 1f, 1f)
        dsp.process(buf, buf.size)
        assertTrue(
            "gain should stay frozen near 0 dB, got ${dsp.debugGainDb()} dB",
            abs(dsp.debugGainDb()) < 0.1f,
        )
    }

    // At aggressiveness 1.0 the same speech-over-noise must unfreeze and lift
    // gain, since the narrowed margin no longer treats it as "too close to the
    // noise to touch".
    @Test
    fun mostAggressiveKeepsRaisingGainWhenSpeechIsCloseToNoise() {
        val dsp = AudioDsp(sr, 1.0f)
        dsp.debugSetNoiseFloorDb(-30.0f)
        dsp.debugSetRmsDb(-30.0f)
        val buf = noiseGapThenSpeechBurst(-30f, -27f, 1f, 1f)
        dsp.process(buf, buf.size)
        // GAIN_RISE_DB_PER_S caps how far gain can climb from 0 dB within a 1 s
        // burst at 3 dB; 2 dB is well above the ~0 dB the frozen case gets.
        assertTrue(
            "gain should have risen well above 0 dB, got ${dsp.debugGainDb()} dB",
            dsp.debugGainDb() > 2.0f,
        )
    }

    // Regardless of aggressiveness, the limiter downstream must still hold the
    // ceiling — a narrower noise margin must never be able to defeat it.
    @Test
    fun mostAggressiveNeverOvershootsTheCeiling() {
        val dsp = AudioDsp(sr, 1.0f)
        dsp.debugSetNoiseFloorDb(-30.0f)
        dsp.debugSetRmsDb(-30.0f)
        val buf = noiseGapThenSpeechBurst(-30f, -27f, 1f, 1f)
        dsp.process(buf, buf.size)
        assertTrue(
            "peak ${peakDb(buf)} dBFS exceeded the ceiling at max aggressiveness",
            peakDb(buf) <= -1.0f + 0.1f,
        )
    }
}
