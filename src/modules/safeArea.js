/**
 * Android safe-area inset fallback.
 *
 * CSS env(safe-area-inset-*) (see main.css) is supposed to be populated by the
 * WebView from WindowInsets once MainActivity's enableEdgeToEdge() draws content
 * behind the system bars. In practice this was observed to report 0 on some
 * Android system images (e.g. emulator images) even though the WebView is drawn
 * edge-to-edge there, leaving content under the status bar. Physical devices
 * tested so far report env() correctly.
 *
 * This queries the real inset natively (StatusBarPlugin.kt `getInsets`) and
 * folds it into the same --safe-area-inset-* variables via max(), so whichever
 * source is non-zero wins — no regression where env() already works, and no
 * effect on Nextcloud/Windows/desktop where this never runs.
 */

const IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

function _isAndroid() {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

function _applyInsets(insets) {
  const root = document.documentElement.style;
  root.setProperty(
    "--safe-area-inset-top",
    `max(env(safe-area-inset-top, 0px), ${insets.top}px)`,
  );
  root.setProperty(
    "--safe-area-inset-bottom",
    `max(env(safe-area-inset-bottom, 0px), ${insets.bottom}px)`,
  );
  root.setProperty(
    "--safe-area-inset-left",
    `max(env(safe-area-inset-left, 0px), ${insets.left}px)`,
  );
  root.setProperty(
    "--safe-area-inset-right",
    `max(env(safe-area-inset-right, 0px), ${insets.right}px)`,
  );
}

async function _fetchAndApplyInsets() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const insets = await invoke("get_safe_area_insets");
    _applyInsets(insets);
  } catch {
    // Non-Tauri (dev browser) or command unavailable — env() fallback stands.
  }
}

/**
 * Start syncing native safe-area insets into CSS. No-op outside Android/Tauri.
 */
export function initSafeArea() {
  if (IS_NEXTCLOUD || !_isAndroid()) return;

  _fetchAndApplyInsets();

  // Insets can change on rotation/fold; refresh on resize.
  window.addEventListener("resize", _fetchAndApplyInsets);
}
