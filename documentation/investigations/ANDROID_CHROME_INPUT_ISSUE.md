# Chrome-for-Android throttles pointermove in the Nextcloud build

**Status: no fix available.** The throttle is inside Chrome-for-Android and no
web API exposes or influences it. This document records the investigation so it
is not repeated from scratch.

All instrumentation used to produce these numbers was temporary and has been
reverted; only the findings are kept.

## Summary

On a **Samsung Galaxy Tab S7 FE**, handwriting in the **Nextcloud (web) build**
is unusable: Chrome delivers only ~15 `pointermove` samples/sec to the page, so
strokes lose waypoints and the preview lags badly.

The same note on the **same device** in the **native (Tauri) build** runs at
~84Hz. A **Galaxy Tab S6 Lite** against the same Nextcloud server runs at ~47Hz
and is fine.

## Measurements

Captured with a temporary on-screen readout. `gap` = ms between input points.

| config | pts gap | rate | frame | draw |
|---|---|---|---|---|
| S7 FE, native Tauri WebView | 12.0ms | 84Hz | 90fps | 0.13ms |
| **S7 FE, NC in Chrome** | **59–78ms** | **~15Hz** | 60–90fps | 0.13ms |
| S7 FE, NC in Firefox | 29.4ms | 34Hz | 60fps | 10.4ms |
| S6 Lite, NC in Chrome | 21.2ms | 47Hz | 60fps | 0.19ms |
| Windows convertible, NC in Edge (pen) | 8.4ms | 120Hz | 60fps | 0.28ms |

Distribution is **unimodal** — a steady rate divider, not intermittent stalling:

| | S7 FE | S6 Lite |
|---|---|---|
| p50 / p95 | 67 / 133ms | 17 / 33ms |
| gaps > 50ms | 96 of ~180 | **0 of 272** |

## Why it feels worse than "15Hz" suggests

15Hz alone would be merely laggy. Four penalties compound:

- **Variance, not just delay.** p95 is 133ms and observed maxima reach 175–222ms.
  A cadence that periodically doubles reads as stuttering; a constant delay would
  not.
- **Pen-down latency is separate and also bad.** 44–63ms in NC vs **8ms native**,
  before the rate throttle applies at all.
- **Short strokes are sub-sampled.** At 15Hz a 200ms stroke captures ~3 points, so
  a "t" crossbar or an "i" dot renders as a straight line or a dash. Native at
  84Hz captures ~17 points for the same gesture. This is the "incomplete strokes"
  symptom — not lost data, but a sample rate below what handwriting *shape*
  requires.
- **Pan and pinch stay smooth**, which sharpens the contrast: they are handled on
  the compositor thread and never reach JS.

## Root cause: pointer dispatch is decoupled from the frame rate

A compositor-thread clock (Web Animations API `transform` animation, `currentTime`
sampled from `requestAnimationFrame`) measured how much compositor time passes per
main-thread frame:

| | S7 FE (slow) | S6 Lite (fast) |
|---|---|---|
| compositor per main-thread frame | 16.6ms = **1.1 vsync** | 16.7ms = **1.0 vsync** |
| frame | 16.6ms 60fps | 16.7ms 60fps |
| pts gap | 58.8ms | 21.2ms |

**Both main threads are served every vsync. Both compositors are healthy. Both run
60fps.** The only difference is how often Chrome hands `pointermove` to JS: **every
~4th frame on the S7 FE, every frame on the S6 Lite.**

This contradicts Chrome's documented
[frame-aligned input](https://developer.chrome.com/blog/aligning-input-events)
behaviour, where `pointermove` is dispatched just before each
`requestAnimationFrame`.

## Ruled out by measurement

| hypothesis | killed by |
|---|---|
| Canvas rendering cost | draw 0.13ms; the *slow* device draws fastest |
| Frame rate / compositing | 60–90fps in both fast and slow cases |
| Main-thread starvation | compositor clock: 1.1 vsync per frame |
| Event queueing | event age ~16ms, constant everywhere |
| Buffer bitmap size | identical 11.5M px in fast native and slow NC |
| `touch-action` on ancestors | a body-class gesture-scope fix measured **inert** in 3 A/B runs; Windows baseline is healthy *with* scrollable permissive ancestors |
| Non-passive listeners | the only 3 were ours; making them passive changed nothing, and native registers the identical ones while running fast |
| Memory / GC pressure | heap 44–52MB of 901–1953MB (2–5%) |
| Panel refresh rate | forcing 90Hz → 60Hz changed nothing |
| Pointer type (S-Pen) | **finger input is equally slow** |
| Nextcloud's page | Firefox on the *same page and device* gets 2.2× the rate |
| Tauri WebView configuration | `RustWebView.kt` sets only JS/storage/media flags — no `requestUnbufferedDispatch`, no touch overrides. Native's 84Hz comes from a **stock** WebView, so there is nothing to port. (The WebView is fast *because* it takes Android's buffered input path — see below.) |

## Why no workaround is possible from JS

- **`pointerrawupdate` is never emitted** in Chrome-for-Android — measured 0 at
  `window` in capture phase on *both* tablets. The one API that bypasses rAF
  alignment does not exist there.
- **`getCoalescedEvents()` returns 1.0 per event** — Chrome genuinely has one
  sample; there is no hidden detail to recover.
- **`requestUnbufferedDispatch()`** is a Kotlin `View` API, unreachable from a
  page. Chrome itself calls it on every pen/finger-down; the WebView does not
  (see the 2026-09-02 update below).

## Mitigation attempted and rejected

Catmull-Rom interpolation between sparse samples fixes stroke **shape** but not
**latency** or **variance**, which is what makes handwriting unusable — it
addresses one of the four penalties above and worsens another, since the curve is
by construction one segment behind the newest sample. Tested on-device: *"a bit
better but still not usable."* It also raised jank 4.8% → 5.9%, and it wrote
synthesised points into stored stroke data (which then syncs and feeds handwriting
recognition). Reverted.

Flutter's
[`PointerEventResampler`](https://api.flutter.dev/flutter/gestures/PointerEventResampler-class.html)
targets the same class of problem ("low frequency sensors, or when the frequency
is not a multiple of the display frequency") by resampling onto the frame clock
**at the cost of added latency**. Not pursued: pen-down latency here is already
44–63ms in NC vs 8ms native, and latency is the actual complaint.

## Workaround for users

Installing the Nextcloud app to the home screen (**PWA / "Add to Home screen"**)
measurably improved stroke completeness on the same S7 FE — no more lost strokes,
though preview latency remained. This is the only intervention that helped and it
requires no code change.

**Recommendation:** use the native app for handwriting on affected devices. The
Nextcloud build remains fine for viewing and light annotation.

### Alternative Android browsers

The loss is specific to **Chrome's own touch-dispatch path** (see the
2026-09-02 update below), not to Chromium rendering in general, so the field
splits by which input path a browser takes:

- **Android System WebView-based browsers should be unaffected**, since they
  take the same buffered, vsync-aligned path the native app already uses.
  Worth trying on affected devices: **Hermit** (site-as-app, no toolbar —
  closest match to the PWA setup), **Via Browser**, **Lightning Browser**,
  **FOSS Browser**, **Privacy Browser**. Not yet verified on-device — the
  recommendation to try these is inferred from the dispatch-path mechanism
  below, not measured.
- **Chromium-based browsers with their own engine (Edge, Brave, Vivaldi,
  Opera, Kiwi, DuckDuckGo) likely inherit the same behaviour**, since they
  build on the same content layer that calls `requestUnbufferedDispatch`.
  **Samsung Internet** is the one uncertain case — Samsung patches the input
  path for the S Pen and may not carry Google's call. Worth a two-minute
  on-device check given the S Pen relevance here.
- **Firefox for Android (GeckoView) does not lose samples** the way Chrome
  does — it forwards full `MotionEvent` history — but is separately slow: see
  the Firefox section below.

None of this has been measured on-device yet; it is a prediction from reading
the Chromium/WebView source, not a repeat of the instrumented A/B testing
above. Treat it as a prioritized list to try, not a confirmed result.

## If this is revisited

The measurements above came from temporary instrumentation that has since been
reverted. Reproducing them needs an on-screen readout of: interval between input
points (mean, p95, max), `pointerrawupdate` counts at `window` in capture phase,
rAF interval, and a compositor-thread clock for the vsync-per-frame figure. The
compositor clock is the load-bearing one — it is what separates "the main thread
is starved" from "dispatch is decoupled from the frame clock."

## Related

Same failure mode, roles inverted (WebView slow, browser fast), also unresolved:
https://github.com/pmndrs/use-gesture/issues/662

The Touch Events spec explicitly permits this: the rate at which touch events are
sent is *"implementation-defined, and may depend on hardware capabilities and
other implementation details."*

## Update 2026-09-02: the loss mechanism, from Chromium source

A second pass against Chromium `HEAD` (verified by reading the files, links
below) explains why the **browser** loses samples while the **WebView** on the
same device does not.

1. **Chrome-the-browser opts out of Android input batching.** On every
   `ACTION_DOWN`, `WebContentsViewAndroid::OnTouchEvent` calls
   `View.requestUnbufferedDispatch(event)`
   ([web_contents_view_android.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/web_contents/web_contents_view_android.cc)).
   The condition is `!UsingSynchronousCompositing() && !kUseAndroidBufferedInputDispatch`.
   **WebView returns `true` from `UsingSynchronousCompositing()`**
   ([aw_content_client.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/common/aw_content_client.cc)),
   so the Tauri app keeps Android's default *buffered* dispatch: one
   vsync-aligned, OS-resampled `MotionEvent` per frame. That is the 84Hz /
   8ms-pen-down side of the table.

   Android's own documentation for `requestUnbufferedDispatch`: *"This API is
   not intended for most applications ... Side effects include: increased
   latency, jittery scrolls and inability to take advantage of system
   resampling."*

2. **Chrome discards every historical sample in a `MotionEvent`.**
   `CreateWebTouchEventFromMotionEvent` builds one `WebTouchEvent` from the
   *current* pointer coordinates only
   ([blink_event_util.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/events/blink/blink_event_util.cc));
   `EventForwarder.sendTouchEvent` reads `getHistorySize()` solely to pick the
   *oldest* timestamp
   ([EventForwarder.java](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/android/java/src/org/chromium/ui/base/EventForwarder.java)).
   Whenever Chrome's **browser-process UI thread** is late reading its input
   channel, Android's `InputConsumer` merges all pending samples into one
   `MotionEvent` with history — and Chrome keeps only the newest position.
   Those samples are gone before the renderer, before `getCoalescedEvents()`,
   before `pointerrawupdate`. That is exactly the measured signature:
   ~15Hz, `getCoalescedEvents() == 1`, renderer main thread and compositor
   healthy at 60fps.

3. **Firefox forwards history.** GeckoView copies `historicalX/Y/Time/...`
   arrays into Gecko
   ([PanZoomController.java](https://hg.mozilla.org/mozilla-central/file/tip/mobile/android/geckoview/src/main/java/org/mozilla/geckoview/PanZoomController.java),
   `widget/android/nsWindow.cpp`), so its 34Hz is a different, Gecko-side
   effect (10ms draw + main-thread coalescing) and not the same bug.

4. **Google knows the trade-off.** Chromium carries a disabled-by-default
   feature `kUseAndroidBufferedInputDispatch` (*"Chrome will NOT call
   requestUnbufferedDispatch"*,
   [components/input/features.h](https://chromium.googlesource.com/chromium/src/+/HEAD/components/input/features.h)),
   a device-specific stylus workaround for exactly this call
   (`crbug.com/1064161`, LG, in `ViewAndroidDelegate.java`), and a TODO on the
   oldest-vs-latest timestamp semantics (`crbug.com/41493853`). None of it is
   reachable from `chrome://flags` on a stock device.

### What this changes in the earlier conclusions

- "`requestUnbufferedDispatch` is only relevant on the side that already
  works" was backwards: the *slow* side calls it, the fast side does not.
- The PWA improvement now has a mechanism: `WebappActivity` runs without
  toolbar / tab strip / omnibox, so the browser UI thread has less to do per
  touch and merges fewer batches. Same engine, same dispatch mode, fewer
  merges.
- The remaining open question is *why* Chrome's UI thread on the S7 FE is
  late (One UI build, Chrome version, tablet tab strip, Samsung stylus
  integration) — or whether Samsung's input stack itself under-delivers to
  unbuffered clients. Either way the loss happens in the browser process, in
  code no page can influence. The verdict stands: **not fixable from the web
  app.**

### One measurement that separates the two remaining hypotheses

Chrome sets the DOM `timeStamp` from the **oldest** sample of a merged batch
(`MotionEventAndroid::GetEventTime()`, [motion_event_android.h](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/events/android/motion_event_android.h)).
So on the S7 FE in Chrome, log `performance.now() - e.timeStamp` per
`pointermove` together with the gap to the previous event:

- **age tracks the gap (50–70ms)** → batches are being merged in Chrome's UI
  thread → Chrome-side jank on this device (Perfetto trace of
  `com.android.chrome` UI thread `deliverInputEvent` would show it).
- **age stays ~16ms while the gap is 67ms** → single-sample events arrive
  60ms apart → Samsung's input stack under-delivers to an unbuffered-dispatch
  window (same class as `crbug.com/1064161`).

The earlier "event age ~16ms" figure was not recorded as `now - e.timeStamp`
specifically, so it cannot settle this.

### Cheap experiments still worth running (no code change)

- **Samsung Internet** on the S7 FE. Chromium-based but Samsung patches the
  input path for the S Pen; if it is smooth, it is a recommendation for NC
  users on Samsung tablets.
- **Edge / Brave / Kiwi** on the S7 FE: stock Chromium input path in a
  different app. Same 15Hz would point at the OS/device; full rate would point
  at Chrome's own UI thread.
- **`chrome://version` on both tablets** and the WebView version inside the
  Tauri app (Settings → Developer options → WebView implementation).

### The one app-side experiment left

`element.requestFullscreen()` on the note editor in the NC build. Fullscreen
hides Chrome's toolbar and tab strip like PWA mode does, without an install.
If the PWA gain came from a quieter browser UI thread, a "handwriting
fullscreen" toggle reproduces it. It does not change the dispatch mode, so it
cannot restore the native rate; it can only reduce merges.

