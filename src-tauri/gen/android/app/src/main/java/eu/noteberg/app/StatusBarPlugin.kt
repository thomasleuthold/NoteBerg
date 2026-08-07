package eu.noteberg.app

import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Keeps the Android status bar icon color in sync with the app's own light/dark
 * theme, and exposes the system bar insets to JS. enableEdgeToEdge() (MainActivity)
 * draws the WebView behind the status/navigation bars, so:
 *  - without setAppearance, the status bar icon color can't track the in-app theme
 *    independently of the OS theme (e.g. white icons over a white app background)
 *  - without getInsets, the page has no reliable way to know how much padding to
 *    reserve — CSS env(safe-area-inset-*) depends on the WebView build/version and
 *    was observed missing on some Android system images (e.g. emulator images)
 *    even though the same CSS works fine on physical devices.
 *
 * Commands:
 *   setAppearance(light: Boolean) — true = dark icons (for a light app background),
 *                                    false = light icons (for a dark app background)
 *   getInsets() -> { top, bottom, left, right } — system bar insets in CSS px (dp)
 */
@TauriPlugin
class StatusBarPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun setAppearance(invoke: Invoke) {
        val args = invoke.getArgs()
        val light = if (args.has("light")) args.getBoolean("light") else true
        activity.runOnUiThread {
            val window = activity.window
            val controller = WindowInsetsControllerCompat(window, window.decorView)
            controller.isAppearanceLightStatusBars = light
        }
        invoke.resolve()
    }

    @Command
    fun getInsets(invoke: Invoke) {
        activity.runOnUiThread {
            val decorView = activity.window.decorView
            val density = activity.resources.displayMetrics.density

            fun resolve(insets: WindowInsetsCompat?) {
                val bars = insets?.getInsets(
                    WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
                )
                val result = JSObject()
                result.put("top", ((bars?.top ?: 0) / density).toDouble())
                result.put("bottom", ((bars?.bottom ?: 0) / density).toDouble())
                result.put("left", ((bars?.left ?: 0) / density).toDouble())
                result.put("right", ((bars?.right ?: 0) / density).toDouble())
                invoke.resolve(result)
            }

            // rootWindowInsets is null before the first layout pass; fall back to a
            // one-shot listener so the very first call after launch still resolves
            // instead of returning zeroes.
            val current = decorView.rootWindowInsets
            if (current != null) {
                resolve(WindowInsetsCompat.toWindowInsetsCompat(current, decorView))
            } else {
                decorView.setOnApplyWindowInsetsListener { view, windowInsets ->
                    decorView.setOnApplyWindowInsetsListener(null)
                    resolve(WindowInsetsCompat.toWindowInsetsCompat(windowInsets, view))
                    windowInsets
                }
                decorView.requestApplyInsets()
            }
        }
    }
}
