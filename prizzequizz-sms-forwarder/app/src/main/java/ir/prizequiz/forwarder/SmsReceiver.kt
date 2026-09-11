package ir.prizequiz.forwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * A MESSAGE ARRIVES.
 *
 * Three decisions happen here and all three are about NOT keeping things:
 *
 * 1. Not from a bank → ignored entirely. The operator's private messages are
 *    none of this app's business and are never written anywhere.
 * 2. Looks like a credential → dropped, before the queue. Not redacted, not
 *    logged, not counted.
 * 3. Otherwise → queued and a send is scheduled. Queued, not sent: the
 *    receiver runs on the main thread with seconds to live, and a deposit
 *    must not depend on the network being up at that instant.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        /* A long SMS arrives split into parts; they have to be joined before
         * anything is matched, or the amount and the account end up in
         * different messages. */
        val byOrigin = mutableMapOf<String, StringBuilder>()
        var timestamp = System.currentTimeMillis()
        for (sms in Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return) {
            val from = sms.originatingAddress ?: ""
            byOrigin.getOrPut(from) { StringBuilder() }.append(sms.messageBody ?: "")
            timestamp = sms.timestampMillis
        }

        val queue = Queue(context)
        var queued = false
        for ((sender, builder) in byOrigin) {
            val body = builder.toString()
            if (!BankSenders.isBank(sender)) continue
            if (SensitiveFilter.isSensitive(body)) {
                /* Deliberately not logging the body, the sender, or anything
                 * that would let it be reconstructed from a bug report. */
                Log.i(TAG, "dropped a message that looks like a credential")
                continue
            }
            queue.add(QueuedSms(
                /* Stable for the same message so a re-delivered broadcast
                 * does not become a second deposit: the server dedupes on
                 * (deviceId, messageId), and this is that id. */
                messageId = messageIdFor(sender, body, timestamp),
                sender = sender,
                body = body,
                receivedAtIso = iso(timestamp)
            ))
            queued = true
        }
        if (queued) ForwardWorker.enqueueNow(context)
    }

    private fun messageIdFor(sender: String, body: String, timestamp: Long): String {
        /* Content-derived, so the SAME message re-delivered by Android gets
         * the same id. Hashed rather than raw, so the id itself carries no
         * message text — it travels in logs and error reports. */
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest("$sender|$timestamp|$body".toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(32)
    }

    companion object {
        private const val TAG = "SmsReceiver"
        fun iso(millis: Long): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date(millis))
    }
}
