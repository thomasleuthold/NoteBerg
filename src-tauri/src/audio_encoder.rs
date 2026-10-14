//! Output encoders for native recording on Windows.
//!
//! Windows only, and gated as such in lib.rs: `hound` is a Windows-target
//! dependency and these encoders serve the cpal capture path. Android encodes
//! in Kotlin with MediaCodec/MediaMuxer and never reaches this module.
//!
//! Two implementations behind one trait:
//!   - [`AacEncoder`] — Media Foundation `IMFSinkWriter` writing AAC-LC in MP4.
//!     48 kHz mono at 96 kbps (the MF encoder's floor) is ~43 MB/hour, against
//!     ~691 MB/hour for the 48 kHz stereo WAV this replaces.
//!   - [`WavEncoder`] — the previous `hound` path, kept as a fallback for
//!     Windows N editions and any other system without the Media Feature Pack,
//!     where every MF call fails at startup.
//!
//! The caller picks with [`create_encoder`], which tries AAC and falls back
//! silently. Both take i16 mono samples at the capture rate.

use std::path::{Path, PathBuf};

pub trait Encoder: Send {
    /// Append mono i16 samples.
    fn write(&mut self, samples: &[i16]) -> Result<(), String>;
    /// Finish and close the file. Consumes the encoder.
    ///
    /// The path and media type are not returned: `create_encoder` already told
    /// the caller which path it chose, and the extension it used is what
    /// `native_audio_stop` derives the type from.
    fn finish(self: Box<Self>) -> Result<(), String>;
}

// ── WAV ──────────────────────────────────────────────────────────────────────

pub struct WavEncoder {
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
}

impl WavEncoder {
    pub fn new(path: &Path, sample_rate: u32) -> Result<Self, String> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let writer = hound::WavWriter::create(path, spec)
            .map_err(|e| format!("Failed to create WAV file: {e}"))?;
        Ok(Self { writer })
    }
}

impl Encoder for WavEncoder {
    fn write(&mut self, samples: &[i16]) -> Result<(), String> {
        for &s in samples {
            self.writer.write_sample(s).map_err(|e| format!("WAV write: {e}"))?;
        }
        Ok(())
    }

    fn finish(self: Box<Self>) -> Result<(), String> {
        self.writer.finalize().map_err(|e| format!("WAV finalize: {e}"))
    }
}

// ── AAC via Media Foundation ─────────────────────────────────────────────────

mod mf {
    use super::Encoder;
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    /// Bitrate for the encoded stream. 96 kbps (12000 bytes/s) is the lowest the
    /// MF AAC encoder accepts; below that `SetOutputMediaType` fails outright.
    const BYTES_PER_SECOND: u32 = 12_000;
    /// MF timestamps are in 100 ns units.
    const HNS_PER_SECOND: i64 = 10_000_000;

    /// Owns COM + Media Foundation startup for the thread it is created on, and
    /// shuts both down on drop. MF is per-process refcounted and COM per-thread,
    /// so this must live on the worker thread, not the command thread.
    struct MfRuntime {
        com_initialized: bool,
    }

    impl MfRuntime {
        fn new() -> Result<Self, String> {
            // SAFETY: standard COM/MF init. The matching uninit runs in Drop.
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                // RPC_E_CHANGED_MODE means COM is already up on this thread with
                // another model; that is usable, but we must not uninit it.
                let com_initialized = hr.is_ok();
                if hr.is_err() && hr != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
                    return Err(format!("CoInitializeEx failed: {hr:?}"));
                }
                MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)
                    .map_err(|e| format!("MFStartup failed: {e}"))?;
                Ok(Self { com_initialized })
            }
        }
    }

    impl Drop for MfRuntime {
        fn drop(&mut self) {
            // SAFETY: mirrors the init in new(), once each.
            unsafe {
                let _ = MFShutdown();
                if self.com_initialized {
                    CoUninitialize();
                }
            }
        }
    }

    pub struct AacEncoder {
        // Declared before `_runtime` so the writer is released before MFShutdown.
        writer: IMFSinkWriter,
        stream_index: u32,
        sample_rate: u32,
        /// Samples written so far; the presentation timestamp is derived from
        /// this rather than from the wall clock, so a pause splices seamlessly.
        samples_written: u64,
        _runtime: MfRuntime,
    }

    // SAFETY: the encoder is created on, used by, and dropped on the single
    // worker thread. It is only `Send` so it can be moved into that thread at
    // spawn time; it is never shared.
    unsafe impl Send for AacEncoder {}

    impl AacEncoder {
        pub fn new(path: &Path, sample_rate: u32) -> Result<Self, String> {
            let runtime = MfRuntime::new()?;

            let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
            wide.push(0);

            // SAFETY: every pointer below is either a valid local or an
            // interface obtained from MF; each call is checked before use.
            unsafe {
                let writer: IMFSinkWriter =
                    MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, None)
                        .map_err(|e| format!("MFCreateSinkWriterFromURL failed: {e}"))?;

                // Output: AAC-LC, mono, 16-bit, at the capture rate.
                let out_type: IMFMediaType =
                    MFCreateMediaType().map_err(|e| format!("MFCreateMediaType failed: {e}"))?;
                out_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                    .map_err(|e| format!("set major type: {e}"))?;
                out_type
                    .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
                    .map_err(|e| format!("set AAC subtype: {e}"))?;
                out_type
                    .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                    .map_err(|e| format!("set bits: {e}"))?;
                out_type
                    .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)
                    .map_err(|e| format!("set rate: {e}"))?;
                out_type
                    .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)
                    .map_err(|e| format!("set channels: {e}"))?;
                out_type
                    .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, BYTES_PER_SECOND)
                    .map_err(|e| format!("set bitrate: {e}"))?;

                let stream_index = writer
                    .AddStream(&out_type)
                    .map_err(|e| format!("AddStream failed: {e}"))?;

                // Input: uncompressed PCM, same layout as the samples we feed.
                let in_type: IMFMediaType =
                    MFCreateMediaType().map_err(|e| format!("MFCreateMediaType failed: {e}"))?;
                in_type
                    .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                    .map_err(|e| format!("set major type: {e}"))?;
                in_type
                    .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
                    .map_err(|e| format!("set PCM subtype: {e}"))?;
                in_type
                    .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                    .map_err(|e| format!("set bits: {e}"))?;
                in_type
                    .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)
                    .map_err(|e| format!("set rate: {e}"))?;
                in_type
                    .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)
                    .map_err(|e| format!("set channels: {e}"))?;

                writer
                    .SetInputMediaType(stream_index, &in_type, None)
                    .map_err(|e| format!("SetInputMediaType failed: {e}"))?;
                writer
                    .BeginWriting()
                    .map_err(|e| format!("BeginWriting failed: {e}"))?;

                Ok(Self {
                    writer,
                    stream_index,
                    sample_rate,
                    samples_written: 0,
                    _runtime: runtime,
                })
            }
        }
    }

    use std::os::windows::ffi::OsStrExt;

    impl Encoder for AacEncoder {
        fn write(&mut self, samples: &[i16]) -> Result<(), String> {
            if samples.is_empty() {
                return Ok(());
            }
            let byte_len = std::mem::size_of_val(samples);

            // SAFETY: the buffer is locked, filled with exactly byte_len bytes
            // and unlocked before being handed to the writer.
            unsafe {
                let buffer: IMFMediaBuffer = MFCreateMemoryBuffer(byte_len as u32)
                    .map_err(|e| format!("MFCreateMemoryBuffer failed: {e}"))?;

                let mut dst: *mut u8 = std::ptr::null_mut();
                buffer
                    .Lock(&mut dst, None, None)
                    .map_err(|e| format!("buffer Lock failed: {e}"))?;
                std::ptr::copy_nonoverlapping(samples.as_ptr() as *const u8, dst, byte_len);
                buffer.Unlock().map_err(|e| format!("buffer Unlock failed: {e}"))?;
                buffer
                    .SetCurrentLength(byte_len as u32)
                    .map_err(|e| format!("SetCurrentLength failed: {e}"))?;

                let sample: IMFSample =
                    MFCreateSample().map_err(|e| format!("MFCreateSample failed: {e}"))?;
                sample
                    .AddBuffer(&buffer)
                    .map_err(|e| format!("AddBuffer failed: {e}"))?;

                // Timestamps derived from the sample count, not the clock.
                let start =
                    (self.samples_written as i64 * HNS_PER_SECOND) / self.sample_rate as i64;
                let duration = (samples.len() as i64 * HNS_PER_SECOND) / self.sample_rate as i64;
                sample
                    .SetSampleTime(start)
                    .map_err(|e| format!("SetSampleTime failed: {e}"))?;
                sample
                    .SetSampleDuration(duration)
                    .map_err(|e| format!("SetSampleDuration failed: {e}"))?;

                self.writer
                    .WriteSample(self.stream_index, &sample)
                    .map_err(|e| format!("WriteSample failed: {e}"))?;
            }

            self.samples_written += samples.len() as u64;
            Ok(())
        }

        fn finish(self: Box<Self>) -> Result<(), String> {
            // SAFETY: Finalize is the documented terminator for a sink writer
            // that has begun writing; the writer is dropped immediately after.
            unsafe {
                self.writer
                    .Finalize()
                    .map_err(|e| format!("Sink writer Finalize failed: {e}"))
            }
        }
    }
}

pub use mf::AacEncoder;

/// Build the best available encoder for `base_path` (given without extension).
///
/// Prefers AAC/MP4; falls back to WAV when Media Foundation is unavailable, as
/// on Windows N editions without the Media Feature Pack. The returned path
/// carries the extension that was actually used.
pub fn create_encoder(
    base_path: &Path,
    sample_rate: u32,
) -> Result<(Box<dyn Encoder>, PathBuf), String> {
    let aac_path = base_path.with_extension("m4a");
    match AacEncoder::new(&aac_path, sample_rate) {
        Ok(enc) => Ok((Box::new(enc), aac_path)),
        Err(e) => {
            eprintln!("[WinAudio] AAC encoder unavailable ({e}); falling back to WAV");
            // A partial .m4a may exist if the failure came after file creation.
            let _ = std::fs::remove_file(&aac_path);
            let wav_path = base_path.with_extension("wav");
            let enc = WavEncoder::new(&wav_path, sample_rate)?;
            Ok((Box::new(enc), wav_path))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("noteberg_rec_test_{name}_{}", std::process::id()))
    }

    #[test]
    fn wav_encoder_writes_a_playable_mono_file() {
        let base = temp_base("wav");
        let path = base.with_extension("wav");
        let _ = std::fs::remove_file(&path);

        let mut enc = Box::new(WavEncoder::new(&path, 48_000).unwrap());
        let samples: Vec<i16> = (0..48_000).map(|i| ((i % 100) * 300 - 15000) as i16).collect();
        enc.write(&samples).unwrap();
        enc.finish().unwrap();

        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().channels, 1, "output must be mono");
        assert_eq!(reader.spec().sample_rate, 48_000);
        assert_eq!(reader.len(), 48_000, "one second of samples");

        let _ = std::fs::remove_file(&path);
    }


    // Guards the real Media Foundation path specifically: the fallback test
    // above passes either way, so without this a silently-broken AAC encoder
    // would look green on a machine that has MF.
    #[test]
    fn aac_encoder_produces_a_valid_mp4() {
        let path = temp_base("aac").with_extension("m4a");
        let _ = std::fs::remove_file(&path);

        let enc = match AacEncoder::new(&path, 48_000) {
            Ok(e) => e,
            // Windows N without the Media Feature Pack: nothing to assert.
            Err(_) => return,
        };
        let mut enc: Box<dyn Encoder> = Box::new(enc);
        // 2 s of a 440 Hz tone, so the file has real content to encode.
        let samples: Vec<i16> = (0..96_000)
            .map(|i| {
                let t = i as f32 / 48_000.0;
                ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 8000.0) as i16
            })
            .collect();
        enc.write(&samples).unwrap();
        enc.finish().unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() > 1000, "suspiciously small: {} bytes", bytes.len());
        // MP4 box structure: bytes 4..8 of the first box are the 'ftyp' type.
        assert_eq!(&bytes[4..8], b"ftyp", "not an MP4 container");
        // The brand list must mention an MP4/M4A brand.
        let head = String::from_utf8_lossy(&bytes[..64.min(bytes.len())]);
        assert!(
            head.contains("mp4") || head.contains("M4A") || head.contains("isom"),
            "unexpected ftyp brands: {head:?}"
        );
        // A 2 s 96 kbps stream is ~24 KB; allow a wide band but catch a stub.
        assert!(
            bytes.len() > 8_000,
            "2 s of audio encoded to only {} bytes",
            bytes.len()
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn create_encoder_yields_a_file_with_a_matching_extension() {
        let base = temp_base("create");
        let (mut enc, path) = create_encoder(&base, 48_000).unwrap();
        enc.write(&vec![0i16; 4800]).unwrap();
        enc.finish().unwrap();

        // The extension is what native_audio_stop derives the media type from,
        // so it must be one the JS side and validate_recording_path accept.
        let ext = path.extension().unwrap().to_str().unwrap();
        assert!(ext == "m4a" || ext == "wav", "unexpected extension {ext}");
        assert!(path.exists(), "encoder produced no file");
        assert!(
            std::fs::metadata(&path).unwrap().len() > 0,
            "encoder produced an empty file"
        );

        let _ = std::fs::remove_file(&path);
    }
}
