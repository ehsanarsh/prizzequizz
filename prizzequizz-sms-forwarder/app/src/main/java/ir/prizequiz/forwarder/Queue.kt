package ir.prizequiz.forwarder

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * THE OFFLINE QUEUE.
 *
 * On a dedicated phone this would be a rare path. On the operator's daily
 * phone it is the normal one: no signal on the metro, Doze overnight, a
 * reboot. So a message is written down the moment it arrives and removed only
 * when the SERVER says it has it — never when the request is merely sent.
 *
 * A plain JSON file rather than a database. The queue holds at most a few
 * dozen short strings, is rewritten whole, and has to survive a reboot; Room
 * would be more machinery for the same guarantee. If this ever needs indexes
 * or partial reads, that is the moment to change it, not before.
 *
 * WHAT IS NEVER IN HERE: anything SensitiveFilter rejected. A credential is
 * dropped before the queue, so it cannot be sitting on disk waiting for
 * signal.
 */
class Queue(context: Context) {

    private val file = File(context.filesDir, "queue.json")

    @Synchronized
    fun add(sms: QueuedSms) {
        val all = read().toMutableList()
        /* The same SMS can be delivered to the receiver more than once. The
         * server dedupes too, but queueing it twice would send it twice and
         * burn a nonce for nothing. */
        if (all.any { it.messageId == sms.messageId }) return
        all.add(sms)
        /* A cap, so a phone that cannot reach the server for a week does not
         * grow without bound. The oldest go first: a deposit from last Tuesday
         * that never arrived is a manual entry now, not a queue problem. */
        while (all.size > MAX_QUEUE) all.removeAt(0)
        write(all)
    }

    @Synchronized
    fun peek(limit: Int): List<QueuedSms> = read().take(limit)

    @Synchronized
    fun remove(messageIds: Set<String>) {
        if (messageIds.isEmpty()) return
        write(read().filterNot { it.messageId in messageIds })
    }

    @Synchronized
    fun depth(): Int = read().size

    @Synchronized
    fun newestReceivedAt(): String? = read().maxOfOrNull { it.receivedAtIso }

    private fun read(): List<QueuedSms> {
        if (!file.exists()) return emptyList()
        return try {
            val arr = JSONArray(file.readText())
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                QueuedSms(
                    messageId = o.getString("messageId"),
                    sender = o.optString("sender"),
                    body = o.getString("body"),
                    receivedAtIso = o.getString("receivedAt")
                )
            }
        } catch (e: Exception) {
            /* A corrupted queue file is not worth crashing the app that is
             * meant to be running unattended. It is one lost batch, and the
             * panel's manual entry is the backstop. */
            emptyList()
        }
    }

    private fun write(items: List<QueuedSms>) {
        val arr = JSONArray()
        for (i in items) {
            arr.put(JSONObject()
                .put("messageId", i.messageId)
                .put("sender", i.sender)
                .put("body", i.body)
                .put("receivedAt", i.receivedAtIso))
        }
        file.writeText(arr.toString())
    }

    companion object { const val MAX_QUEUE = 200 }
}

data class QueuedSms(
    val messageId: String,
    val sender: String,
    val body: String,
    val receivedAtIso: String
)
