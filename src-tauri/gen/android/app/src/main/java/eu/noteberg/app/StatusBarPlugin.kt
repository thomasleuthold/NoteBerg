package eu.noteberg.app

import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Keeps the Android status bar icon color in sync with the app's own light/dark
 * theme. enableEdgeToEdge() (MainActivity) draws the WebView behind the status
 * bar, so the bar's icon color is the only thing distinguishing it from the app
 * background — without this, switching the in-app theme independently of the
 * OS theme leaves white icons over a white app background (or the reverse).
 *
 * Commands:
 *   setAppearance(light: Boolean) — true = dark icons (for a light app background),
 *                                    false = light icons (for a dark app background)
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
}
