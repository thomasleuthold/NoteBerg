//! Voice-recorder DSP chain, shared by every native recording path.
//!
//! Replaces the old port of the browser Web Audio chain (downward compressor →
//! fixed +0.8 dB make-up → look-ahead-less limiter → hard clamp), which could
//! not raise a quiet input at all and clipped transients into clicks. See
//! `documentation/investigations/AUDIO_RECORDING_LEVEL_ARTIFACTS_LENGTH.md`,
//! findings F1–F3 and design D1.
//!
//! Chain, on mono samples:
//!   1. downmix to mono (caller-side, via [`downmix_to_mono`])
//!   2. high-pass at 80 Hz — removes DC offset, rumble and handling noise that
//!      would otherwise bias the level estimate
//!   3. slow AGC — targets -20 dBFS RMS, gain interpolated per sample
//!   4. true look-ahead peak limiter — ceiling -1 dBFS, nothing can exceed it
//!   5. pause/resume fades — 5 ms, applied by the caller at splice points
//!
//! Deliberately platform-independent and free of any I/O so it can be unit
//! tested directly (`cargo test`) and, later, called from Kotlin over JNI.

/// Everything downstream assumes mono; stereo input is averaged, not dropped.
/// Also removes the old interleaved-channel bug, where an L,R,L,R stream ran
/// through one detector and halved its effective time constants.
pub fn downmix_to_mono(interleaved: &[f32], channels: u16, out: &mut Vec<f32>) {
    out.clear();
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let ch = channels as usize;
    let scale = 1.0 / ch as f32;
    for frame in interleaved.chunks_exact(ch) {
        out.push(frame.iter().sum::<f32>() * scale);
    }
}

// ── Tuning ───────────────────────────────────────────────────────────────────

/// Target loudness. -20 dBFS RMS is the usual voice-recorder resting point: far
/// enough below full scale that speech peaks have room, loud enough to be
/// comfortable without amplification.
const TARGET_RMS_DB: f32 = -20.0;
/// Window the RMS is measured over. Long enough to average across syllables
/// rather than chase them.
const RMS_WINDOW_S: f32 = 0.4;
/// Block size the gain is recomputed at; the gain is then interpolated per
/// sample across the block, so there is no zipper noise.
const BLOCK_S: f32 = 0.01;
const MAX_GAIN_DB: f32 = 30.0;
const MIN_GAIN_DB: f32 = -6.0;
/// Asymmetric slew: rising slowly avoids pumping, falling quickly protects
/// against a sudden loud passage.
const GAIN_RISE_DB_PER_S: f32 = 3.0;
const GAIN_FALL_DB_PER_S: f32 = 30.0;
/// The gain is frozen when a block is within this margin of the tracked noise
/// floor, so silence and room tone are not amplified into hiss.
///
/// User-adjustable via `aggressiveness` (see [`noise_margin_db`]): this is the
/// value at aggressiveness 0.0, i.e. today's default behaviour.
const NOISE_MARGIN_DB_MIN_AGGRESSIVENESS: f32 = 6.0;
/// Noise margin at aggressiveness 1.0. In steady loud noise (e.g. driving) the
/// old fixed 6 dB margin keeps the gain frozen well short of the -20 dBFS
/// target, because speech is judged "too close to the noise" to lift further.
/// Narrowing the margin lets the AGC keep pushing gain up in exactly that case,
/// at the cost of also lifting the noise floor itself closer to speech level.
const NOISE_MARGIN_DB_MAX_AGGRESSIVENESS: f32 = 1.5;
const NOISE_RISE_DB_PER_S: f32 = 1.0;
const NOISE_FALL_DB_PER_S: f32 = 20.0;
/// Limiter ceiling. The final clamp then never engages.
const CEILING_DB: f32 = -1.0;
const LOOKAHEAD_S: f32 = 0.005;
const LIMITER_RELEASE_S: f32 = 0.08;
/// Fade applied at pause and resume, so a splice is not a step discontinuity.
pub const FADE_S: f32 = 0.005;

const SILENCE_DB: f32 = -120.0;

#[inline]
fn lin_to_db(x: f32) -> f32 {
    if x < 1e-7 {
        SILENCE_DB
    } else {
        20.0 * x.log10()
    }
}

#[inline]
fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Map a 0.0–1.0 aggressiveness knob to the noise margin, linearly.
#[inline]
fn noise_margin_db(aggressiveness: f32) -> f32 {
    let t = aggressiveness.clamp(0.0, 1.0);
    NOISE_MARGIN_DB_MIN_AGGRESSIVENESS
        + (NOISE_MARGIN_DB_MAX_AGGRESSIVENESS - NOISE_MARGIN_DB_MIN_AGGRESSIVENESS) * t
}

/// Second-order Butterworth high-pass, direct form I.
struct HighPass {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl HighPass {
    fn new(cutoff_hz: f32, sample_rate: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * cutoff_hz / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        // Q = 1/sqrt(2): Butterworth, maximally flat passband.
        let alpha = sin_w0 / std::f32::consts::SQRT_2;
        let a0 = 1.0 + alpha;
        Self {
            b0: ((1.0 + cos_w0) / 2.0) / a0,
            b1: (-(1.0 + cos_w0)) / a0,
            b2: ((1.0 + cos_w0) / 2.0) / a0,
            a1: (-2.0 * cos_w0) / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Look-ahead peak limiter. Holds a delay line of exactly the look-ahead
/// length, and a running maximum over that window, so gain reduction is already
/// in place by the time the peak it was computed for arrives at the output.
/// Nothing can therefore exceed the ceiling — the old limiter smoothed its
/// detector with a 1 ms attack and had no look-ahead, so transients passed
/// through and were hard-clipped into clicks.
struct Limiter {
    delay: Vec<f32>,
    pos: usize,
    gain_db: f32,
    release_per_sample_db: f32,
    ceiling_lin: f32,
}

impl Limiter {
    fn new(sample_rate: f32) -> Self {
        let len = ((LOOKAHEAD_S * sample_rate) as usize).max(1);
        Self {
            delay: vec![0.0; len],
            pos: 0,
            gain_db: 0.0,
            release_per_sample_db: (CEILING_DB.abs() + MAX_GAIN_DB) / (LIMITER_RELEASE_S * sample_rate),
            ceiling_lin: db_to_lin(CEILING_DB),
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        // Insert the incoming sample, take the one leaving the delay line.
        let out = self.delay[self.pos];
        self.delay[self.pos] = x;
        self.pos = (self.pos + 1) % self.delay.len();

        // Required gain is computed over the whole look-ahead window, so a peak
        // still in the delay line already pulls the gain down.
        let window_peak = self
            .delay
            .iter()
            .fold(0.0f32, |acc, &s| acc.max(s.abs()));
        let required_db = if window_peak > self.ceiling_lin {
            lin_to_db(self.ceiling_lin) - lin_to_db(window_peak)
        } else {
            0.0
        };

        // Attack is instantaneous (the look-ahead is what buys the time);
        // release is gradual to avoid audible pumping.
        if required_db < self.gain_db {
            self.gain_db = required_db;
        } else {
            self.gain_db = (self.gain_db + self.release_per_sample_db).min(required_db.min(0.0));
        }

        out * db_to_lin(self.gain_db)
    }
}

/// Persistent state of the chain. One instance per recording.
pub struct DspState {
    sample_rate: f32,
    high_pass: HighPass,
    limiter: Limiter,
    /// Squared-sample accumulator for the RMS window.
    rms_acc: f32,
    rms_count: usize,
    rms_window: usize,
    /// Last completed window's RMS, in dB.
    rms_db: f32,
    block_len: usize,
    block_pos: usize,
    gain_db: f32,
    /// Gain at the start of the current block; interpolated toward `gain_db`.
    gain_db_prev: f32,
    noise_floor_db: f32,
    fade_len: usize,
    /// Counts down a fade-in after a resume.
    fade_in_remaining: usize,
    /// Current noise margin, derived from the user's aggressiveness setting.
    /// Read fresh from an atomic each block by callers that support a live
    /// update (see `set_aggressiveness`), so a mid-recording change takes
    /// effect at the next block boundary rather than waiting for a restart.
    noise_margin_db: f32,
}

impl DspState {
    pub fn new(sample_rate: u32, aggressiveness: f32) -> Self {
        let sr = sample_rate as f32;
        let block_len = ((BLOCK_S * sr) as usize).max(1);
        Self {
            sample_rate: sr,
            high_pass: HighPass::new(80.0, sr),
            limiter: Limiter::new(sr),
            rms_acc: 0.0,
            rms_count: 0,
            rms_window: ((RMS_WINDOW_S * sr) as usize).max(1),
            rms_db: SILENCE_DB,
            block_len,
            block_pos: 0,
            gain_db: 0.0,
            gain_db_prev: 0.0,
            noise_floor_db: SILENCE_DB,
            fade_len: ((FADE_S * sr) as usize).max(1),
            fade_in_remaining: 0,
            noise_margin_db: noise_margin_db(aggressiveness),
        }
    }

    /// Update the noise margin live, from a 0.0-1.0 aggressiveness value.
    /// Safe to call mid-recording: the new margin is picked up at the next
    /// block boundary, same as any other gain recomputation.
    pub fn set_aggressiveness(&mut self, aggressiveness: f32) {
        self.noise_margin_db = noise_margin_db(aggressiveness);
    }

    /// Number of samples a fade covers. Callers that hold audio back so a fade
    /// can be applied retroactively need to know this.
    pub fn fade_len(&self) -> usize {
        self.fade_len
    }

    /// Arm a fade-in; call on resume so the splice is not a step.
    pub fn begin_fade_in(&mut self) {
        self.fade_in_remaining = self.fade_len;
    }

    /// Apply a fade-out to the tail of `samples`; call before pausing.
    pub fn apply_fade_out(&self, samples: &mut [f32]) {
        let n = self.fade_len.min(samples.len());
        if n == 0 {
            return;
        }
        let start = samples.len() - n;
        for (i, s) in samples[start..].iter_mut().enumerate() {
            *s *= 1.0 - (i as f32 / n as f32);
        }
    }

    /// Recompute the target gain at a block boundary.
    fn update_gain(&mut self) {
        let block_dt = self.block_len as f32 / self.sample_rate;

        // Track the noise floor: rises slowly, falls quickly, so it settles on
        // the quietest recent material rather than on speech.
        if self.rms_db < self.noise_floor_db {
            let step = NOISE_FALL_DB_PER_S * block_dt;
            self.noise_floor_db = (self.noise_floor_db - step).max(self.rms_db);
        } else {
            let step = NOISE_RISE_DB_PER_S * block_dt;
            self.noise_floor_db = (self.noise_floor_db + step).min(self.rms_db);
        }

        self.gain_db_prev = self.gain_db;

        // Freeze on silence and on room tone: without this the AGC would drive
        // its +30 dB into the noise floor between phrases and turn a quiet room
        // into audible hiss.
        if self.rms_db <= SILENCE_DB || self.rms_db < self.noise_floor_db + self.noise_margin_db {
            return;
        }

        let desired = (TARGET_RMS_DB - self.rms_db).clamp(MIN_GAIN_DB, MAX_GAIN_DB);
        let max_rise = GAIN_RISE_DB_PER_S * block_dt;
        let max_fall = GAIN_FALL_DB_PER_S * block_dt;
        self.gain_db = if desired > self.gain_db {
            (self.gain_db + max_rise).min(desired)
        } else {
            (self.gain_db - max_fall).max(desired)
        };
    }
}

/// Run the chain over one buffer of mono samples, in place.
/// Returns the output peak, for the level meter.
pub fn process(samples: &mut [f32], st: &mut DspState) -> f32 {
    let mut peak = 0f32;

    for s in samples.iter_mut() {
        let x = st.high_pass.process(*s);

        // Level estimate is taken pre-gain, so the AGC measures the input.
        st.rms_acc += x * x;
        st.rms_count += 1;
        if st.rms_count >= st.rms_window {
            let mean = st.rms_acc / st.rms_count as f32;
            st.rms_db = lin_to_db(mean.sqrt());
            st.rms_acc = 0.0;
            st.rms_count = 0;
        }

        if st.block_pos == 0 {
            st.update_gain();
        }

        // Interpolate across the block so gain never steps.
        let t = st.block_pos as f32 / st.block_len as f32;
        let g_db = st.gain_db_prev + (st.gain_db - st.gain_db_prev) * t;
        let mut y = x * db_to_lin(g_db);

        st.block_pos += 1;
        if st.block_pos >= st.block_len {
            st.block_pos = 0;
        }

        if st.fade_in_remaining > 0 {
            let done = st.fade_len - st.fade_in_remaining;
            y *= done as f32 / st.fade_len as f32;
            st.fade_in_remaining -= 1;
        }

        let out = st.limiter.process(y);
        *s = out;
        let a = out.abs();
        if a > peak {
            peak = a;
        }
    }

    peak
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn sine(freq: f32, amp_db: f32, secs: f32, sample_rate: u32) -> Vec<f32> {
        let amp = db_to_lin(amp_db);
        let n = (secs * sample_rate as f32) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                amp * (2.0 * std::f32::consts::PI * freq * t).sin()
            })
            .collect()
    }

    fn rms_db(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return SILENCE_DB;
        }
        let mean = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
        lin_to_db(mean.sqrt())
    }

    fn peak_db(samples: &[f32]) -> f32 {
        lin_to_db(samples.iter().fold(0.0f32, |a, &s| a.max(s.abs())))
    }

    // A quiet input is the case the old chain could not fix at all: a
    // downward compressor does nothing below its threshold, so a -40 dBFS
    // input stayed at roughly -39 dBFS (F2).
    #[test]
    fn quiet_input_reaches_target_within_ten_seconds() {
        let mut st = DspState::new(SR, 0.0);
        let mut buf = sine(440.0, -40.0, 12.0, SR);
        process(&mut buf, &mut st);

        // Measure the last second, by which the slow ramp has arrived.
        let tail = &buf[buf.len() - SR as usize..];
        let got = rms_db(tail);
        assert!(
            (got - TARGET_RMS_DB).abs() <= 3.0,
            "tail RMS {got:.1} dBFS should be within 3 dB of {TARGET_RMS_DB}"
        );
    }

    #[test]
    fn quiet_input_never_overshoots_the_ceiling() {
        let mut st = DspState::new(SR, 0.0);
        let mut buf = sine(440.0, -40.0, 12.0, SR);
        process(&mut buf, &mut st);
        assert!(
            peak_db(&buf) <= CEILING_DB + 0.1,
            "peak {:.2} dBFS exceeded the ceiling",
            peak_db(&buf)
        );
    }

    // The old limiter smoothed its detector with a 1 ms attack and had no
    // look-ahead, so a transient passed through and was hard-clamped — an
    // audible click (F3).
    #[test]
    fn full_scale_burst_produces_nothing_above_the_ceiling() {
        let mut st = DspState::new(SR, 0.0);
        let mut buf = sine(440.0, -30.0, 1.0, SR);
        buf.extend(sine(1000.0, 0.0, 0.5, SR));
        buf.extend(sine(440.0, -30.0, 1.0, SR));
        process(&mut buf, &mut st);
        assert!(
            peak_db(&buf) <= CEILING_DB + 0.1,
            "burst peaked at {:.2} dBFS",
            peak_db(&buf)
        );
    }

    #[test]
    fn digital_silence_does_not_raise_the_gain() {
        let mut st = DspState::new(SR, 0.0);
        let mut buf = vec![0.0f32; SR as usize * 5];
        let peak = process(&mut buf, &mut st);
        assert_eq!(peak, 0.0, "silence must stay silent");
        assert!(
            st.gain_db.abs() < 0.001,
            "gain drifted to {:.3} dB on silence",
            st.gain_db
        );
        assert!(buf.iter().all(|s| s.abs() < 1e-6));
    }

    // Room tone must not be treated as signal to be lifted to the target, or a
    // quiet room becomes hiss between phrases.
    #[test]
    fn steady_room_tone_is_not_amplified_to_the_target() {
        let mut st = DspState::new(SR, 0.0);
        // -65 dBFS broadband-ish tone, well below speech.
        let mut buf = sine(200.0, -65.0, 10.0, SR);
        process(&mut buf, &mut st);
        let tail = rms_db(&buf[buf.len() - SR as usize..]);
        assert!(
            tail < TARGET_RMS_DB - 10.0,
            "room tone was lifted to {tail:.1} dBFS, near the speech target"
        );
    }

    #[test]
    fn gain_changes_are_smooth_enough_to_avoid_zipper_noise() {
        let mut st = DspState::new(SR, 0.0);
        let mut buf = sine(440.0, -40.0, 6.0, SR);
        process(&mut buf, &mut st);

        // Compare the envelope block to block rather than sample to sample: a
        // 440 Hz sine legitimately moves fast within a cycle.
        //
        // Skip the first 50 ms: the high-pass starts from zero state and its
        // settling transient is a filter artifact, not gain movement. (Measured
        // at ~3.1 dB across the first two 10 ms blocks, while gain_db is still
        // exactly 0 — so a bound applied there would be testing the wrong
        // thing.)
        let block = (SR / 100) as usize; // 10 ms
        let skip = 5;
        // The AGC may rise at GAIN_RISE_DB_PER_S, i.e. 0.03 dB per 10 ms block.
        // Allow an order of magnitude over that and it still catches any step.
        const MAX_BLOCK_STEP_DB: f32 = 0.5;

        let mut prev: Option<f32> = None;
        for chunk in buf.chunks(block).skip(skip) {
            let level = rms_db(chunk);
            if level <= SILENCE_DB {
                continue;
            }
            if let Some(p) = prev {
                assert!(
                    (level - p).abs() < MAX_BLOCK_STEP_DB,
                    "envelope jumped {:.2} dB between 10 ms blocks",
                    level - p
                );
            }
            prev = Some(level);
        }
    }

    // The settling transient the test above skips must decay quickly and must
    // not be a loud click in its own right.
    #[test]
    fn high_pass_startup_transient_is_brief_and_quiet() {
        let mut st = DspState::new(SR, 0.0);
        let mut buf = sine(440.0, -40.0, 0.5, SR);
        process(&mut buf, &mut st);

        let first_50ms = &buf[..(SR / 20) as usize];
        assert!(
            peak_db(first_50ms) < -20.0,
            "startup transient peaked at {:.1} dBFS",
            peak_db(first_50ms)
        );
    }

    // A speaker moving closer, or a sudden loud passage: the gain must come
    // down fast enough that the limiter is not the only thing holding the line.
    #[test]
    fn a_step_up_in_level_never_exceeds_the_ceiling() {
        let mut st = DspState::new(SR, 0.0);
        let mut buf = sine(440.0, -40.0, 3.0, SR);
        buf.extend(sine(440.0, -10.0, 3.0, SR));
        process(&mut buf, &mut st);
        assert!(
            peak_db(&buf) <= CEILING_DB + 0.1,
            "step transition peaked at {:.2} dBFS",
            peak_db(&buf)
        );
    }


    #[test]
    fn downmix_averages_stereo_to_mono() {
        let mut out = Vec::new();
        downmix_to_mono(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn downmix_passes_mono_through_unchanged() {
        let mut out = Vec::new();
        downmix_to_mono(&[0.1, -0.2, 0.3], 1, &mut out);
        assert_eq!(out, vec![0.1, -0.2, 0.3]);
    }

    #[test]
    fn high_pass_removes_a_dc_offset() {
        let mut st = DspState::new(SR, 0.0);
        // Constant input is pure DC; after the high-pass it must decay to zero.
        let mut buf = vec![0.5f32; SR as usize];
        process(&mut buf, &mut st);
        let tail = &buf[buf.len() - 1000..];
        assert!(
            tail.iter().all(|s| s.abs() < 0.01),
            "DC offset survived the high-pass"
        );
    }

    #[test]
    fn fade_out_ramps_the_tail_to_zero() {
        let st = DspState::new(SR, 0.0);
        let mut buf = vec![1.0f32; st.fade_len * 2];
        st.apply_fade_out(&mut buf);
        assert_eq!(buf[0], 1.0, "samples before the fade are untouched");
        assert!(*buf.last().unwrap() < 0.01, "tail must reach ~zero");
        // Monotonically decreasing across the fade region.
        for w in buf[st.fade_len..].windows(2) {
            assert!(w[1] <= w[0]);
        }
    }

    #[test]
    fn fade_in_starts_from_silence_after_a_resume() {
        let mut st = DspState::new(SR, 0.0);
        st.begin_fade_in();
        let mut buf = sine(440.0, -20.0, 0.05, SR);
        process(&mut buf, &mut st);
        assert!(buf[0].abs() < 1e-3, "resume must not step from silence");
    }

    /// A speech burst riding on continuous, steady road/engine noise, preceded
    /// by a noise-only gap (as between words) so the noise-floor tracker has
    /// actually learned the noise level rather than the noise+speech blend —
    /// the same way a real drive has pauses between phrases the floor can settle
    /// into. Close enough to the noise that the default 6 dB margin freezes
    /// gain before it reaches the speech target — the reported problem.
    ///
    /// The gap is only 1 s of simulated audio even though the tracker's rise
    /// side moves at just `NOISE_RISE_DB_PER_S` = 1 dB/s (which would take well
    /// over a minute to climb from silence unaided): the state's noise floor is
    /// seeded near `noise_db` first, so the gap only needs to hold it there
    /// under the fast `NOISE_FALL_DB_PER_S`, not climb to it from cold.
    fn noise_gap_then_speech_burst(
        noise_db: f32,
        speech_db: f32,
        gap_secs: f32,
        speech_secs: f32,
        sample_rate: u32,
    ) -> Vec<f32> {
        let mut out = sine(120.0, noise_db, gap_secs, sample_rate);
        let noise_during_speech = sine(120.0, noise_db, speech_secs, sample_rate);
        let speech = sine(440.0, speech_db, speech_secs, sample_rate);
        out.extend(
            noise_during_speech
                .iter()
                .zip(speech.iter())
                .map(|(&n, &s)| n + s),
        );
        out
    }

    // The scenario the aggressiveness setting exists to fix: at aggressiveness
    // 0.0 (today's shipped default), gain must stay frozen because speech sits
    // within the old 6 dB margin of the noise floor.
    #[test]
    fn least_aggressive_freezes_gain_when_speech_is_close_to_noise() {
        let mut st = DspState::new(SR, 0.0);
        st.noise_floor_db = -30.0;
        st.rms_db = -30.0;
        let mut buf = noise_gap_then_speech_burst(-30.0, -27.0, 1.0, 1.0, SR);
        process(&mut buf, &mut st);
        assert!(
            st.gain_db.abs() < 0.1,
            "gain should stay frozen near 0 dB, got {:.2} dB",
            st.gain_db
        );
    }

    // At aggressiveness 1.0 the same speech-over-noise must unfreeze and lift
    // gain, since the narrowed margin no longer treats it as "too close to the
    // noise to touch".
    #[test]
    fn most_aggressive_keeps_raising_gain_when_speech_is_close_to_noise() {
        let mut st = DspState::new(SR, 1.0);
        st.noise_floor_db = -30.0;
        st.rms_db = -30.0;
        let mut buf = noise_gap_then_speech_burst(-30.0, -27.0, 1.0, 1.0, SR);
        process(&mut buf, &mut st);
        // GAIN_RISE_DB_PER_S caps how far gain can climb from 0 dB within a 1 s
        // burst at 3 dB; the bound checked here is well above the ~0 dB the
        // frozen (aggressiveness 0.0) case gets in the sibling test, which is
        // what this test needs to demonstrate.
        assert!(
            st.gain_db > 2.0,
            "gain should have risen well above 0 dB, got {:.2} dB",
            st.gain_db
        );
    }

    // Regardless of aggressiveness, the limiter downstream must still hold the
    // ceiling — a narrower noise margin must never be able to defeat it.
    #[test]
    fn most_aggressive_never_overshoots_the_ceiling() {
        let mut st = DspState::new(SR, 1.0);
        st.noise_floor_db = -30.0;
        st.rms_db = -30.0;
        let mut buf = noise_gap_then_speech_burst(-30.0, -27.0, 1.0, 1.0, SR);
        process(&mut buf, &mut st);
        assert!(
            peak_db(&buf) <= CEILING_DB + 0.1,
            "peak {:.2} dBFS exceeded the ceiling at max aggressiveness",
            peak_db(&buf)
        );
    }

    // set_aggressiveness must actually change behaviour on an existing state,
    // not merely at construction — this is what makes the live slider work.
    #[test]
    fn set_aggressiveness_changes_the_noise_margin_live() {
        let mut st = DspState::new(SR, 0.0);
        assert!((st.noise_margin_db - NOISE_MARGIN_DB_MIN_AGGRESSIVENESS).abs() < 1e-6);
        st.set_aggressiveness(1.0);
        assert!((st.noise_margin_db - NOISE_MARGIN_DB_MAX_AGGRESSIVENESS).abs() < 1e-6);
    }

    #[test]
    fn noise_margin_db_clamps_out_of_range_input() {
        assert_eq!(noise_margin_db(-1.0), NOISE_MARGIN_DB_MIN_AGGRESSIVENESS);
        assert_eq!(noise_margin_db(2.0), NOISE_MARGIN_DB_MAX_AGGRESSIVENESS);
    }
}
