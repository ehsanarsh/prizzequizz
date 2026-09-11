package ir.prizequiz.forwarder

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * TALKING TO THE SERVER.
 *
 * Every request but pairing is signed:
 *
 *   signature = HMAC-SHA256(secret, deviceId \n timestamp \n nonce \n sha256(body))
 *
 * The secret never crosses the wire after pairing — only the signature does.
 * The server checks the timestamp against a five-minute window and refuses a
 * nonce it has already seen, so a captured request neither works later nor
 * works twice.
 *
 * The body is signed as the EXACT string that is sent. Building the JSON once
 * and using that same string for both is not tidiness: re-serialising it
 * anywhere would change the hash and every honest request would fail.
 */
class ApiClient(private val credentials: Credentials) {

    class Unauthorised(message: String) : Exception(message)

    fun pair(code: String, label: String): Pair<String, String> {
        val body = JSONObject().put("pairingCode", code).put("label", label)
            .put("appVersion", BuildConfig.VERSION_NAME).toString()
        val res = post("/bank-sms/pair", body, signed = false)
        val data = JSONObject(res).getJSONObject("data")
        return data.getString("deviceId") to data.getString("secret")
    }

    /**
     * Send a batch and report, per message, what the server did with it.
     *
     * The per-message answer is what lets the queue be honest: a message the
     * server stored — including one it deliberately dropped as a credential —
     * leaves the queue, and one it failed on stays. A batch-level "ok" would
     * force the app to guess, and guessing about a deposit means either losing
     * one or sending it forever.
     */
    fun sendMessages(messages: List<QueuedSms>): Map<String, Boolean> {
        val arr = JSONArray()
        for (m in messages) {
            arr.put(JSONObject()
                .put("messageId", m.messageId)
                .put("sender", m.sender)
                .put("body", m.body)
                .put("receivedAt", m.receivedAtIso))
        }
        val body = JSONObject().put("messages", arr).toString()
        val res = post("/bank-sms/transactions", body, signed = true)
        val results = JSONObject(res).getJSONObject("data").getJSONArray("results")
        val out = mutableMapOf<String, Boolean>()
        for (i in 0 until results.length()) {
            val r = results.getJSONObject(i)
            out[r.optString("messageId")] = r.optBoolean("stored", false)
        }
        return out
    }

    fun heartbeat(queueDepth: Int, batteryOptimized: Boolean, lastSmsAt: String?) {
        val body = JSONObject()
            .put("queueDepth", queueDepth)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("batteryOptimized", batteryOptimized)
            .apply { if (lastSmsAt != null) put("lastSmsAt", lastSmsAt) }
            .toString()
        post("/bank-sms/heartbeat", body, signed = true)
    }

    private fun post(path: String, body: String, signed: Boolean): String {
        val conn = (URL(BuildConfig.API_BASE + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Content-Type", "application/json")
        }
        if (signed) {
            val deviceId = credentials.deviceId ?: throw Unauthorised("not paired")
            val secret = credentials.secret ?: throw Unauthorised("not paired")
            val timestamp = System.currentTimeMillis().toString()
            val nonce = UUID.randomUUID().toString()
            conn.setRequestProperty("X-Device-Id", deviceId)
            conn.setRequestProperty("X-Timestamp", timestamp)
            conn.setRequestProperty("X-Nonce", nonce)
            conn.setRequestProperty("X-Signature", sign(secret, deviceId, timestamp, nonce, body))
        }
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.use(BufferedReader::readText) ?: ""
        if (code == 401) {
            /* The server no longer knows us — revoked, or a secret that no
             * longer opens. Retrying forever would be pointless and would
             * hide the problem; the operator has to re-pair. */
            throw Unauthorised(text)
        }
        if (code !in 200..299) throw Exception("HTTP $code: ${text.take(200)}")
        return text
    }

    private fun sign(secret: String, deviceId: String, timestamp: String, nonce: String, body: String): String {
        val bodyHash = MessageDigest.getInstance("SHA-256")
            .digest(body.toByteArray(Charsets.UTF_8)).toHex()
        val mac = Mac.getInstance("HmacSHA256").apply {
            init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        }
        return mac.doFinal("$deviceId\n$timestamp\n$nonce\n$bodyHash".toByteArray(Charsets.UTF_8)).toHex()
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
