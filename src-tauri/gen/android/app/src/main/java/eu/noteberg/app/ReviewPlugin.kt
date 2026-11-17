package eu.noteberg.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Opens this app's Google Play page, for the "Rate this app" button in Settings.
 *
 * Commands:
 *   openStoreListing() — opens the Play Store app on this app's page, falling back
 *                         to the web URL on a device without the Play Store app.
 *
 * There is deliberately no Play In-App Review flow: the app never asks for a
 * rating on its own, and that sheet is quota-limited and silently does nothing
 * once the quota is spent, which is wrong for a button pressed on purpose.
 */
@TauriPlugin
class ReviewPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun openStoreListing(invoke: Invoke) {
        val pkg = activity.packageName
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(market)
        } catch (e: ActivityNotFoundException) {
            val web = Intent(
                Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=$pkg"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                activity.startActivity(web)
            } catch (e2: ActivityNotFoundException) {
                invoke.reject("No app can open the store page", "NO_HANDLER")
                return
            }
        }
        invoke.resolve()
    }
}
