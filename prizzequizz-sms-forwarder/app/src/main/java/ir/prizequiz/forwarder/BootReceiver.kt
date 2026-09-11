package ir.prizequiz.forwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arm after a reboot.
 *
 * WorkManager restores its own periodic work, but only once something has
 * asked it to this boot. On a phone that reboots and is not opened for a day,
 * that "something" has to be this — otherwise the queue sits full and the
 * panel shows a device that went quiet for no visible reason.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        ForwardWorker.schedulePeriodic(context)
        ForwardWorker.enqueueNow(context)
    }
}
