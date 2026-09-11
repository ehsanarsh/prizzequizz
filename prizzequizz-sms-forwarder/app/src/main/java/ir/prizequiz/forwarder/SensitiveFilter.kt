package ir.prizequiz.forwarder

/**
 * WHAT NEVER LEAVES THIS PHONE.
 *
 * This is the operator's DAILY phone, so it receives their own رمز پویا,
 * verification codes and card details alongside the bank's deposit
 * notifications. Those are credentials. They are of no use to the game and
 * every use to whoever gets hold of them, so the rule is not "redact" — a
 * message that looks like one is dropped whole, before it is queued, before
 * it is stored, before anything touches the network.
 *
 * The server runs this same filter again and does NOT trust this one. That is
 * deliberate and not redundancy for its own sake: a phone can be stolen,
 * downgraded, or replaced by something else speaking the same protocol, and
 * "the client already checked" has never been a security boundary. This copy
 * exists so the credential does not leave the device in the first place; the
 * server's copy exists because this one might not have run.
 *
 * The list errs toward dropping. A deposit notification that happens to
 * contain «رمز» is a payment the operator can type into the panel by hand; a
 * stored رمز پویا is a credential in somebody's database, and no amount of
 * care afterwards takes that back.
 */
object SensitiveFilter {

    private val PATTERNS = listOf(
        Regex("رمز"),
        Regex("پویا"),
        Regex("یکبار\\s*مصرف"),
        Regex("کد\\s*(تایید|تأیید|فعالسازی|فعال\\s*سازی|ورود|امنیتی)"),
        Regex("\\bOTP\\b", RegexOption.IGNORE_CASE),
        Regex("\\bCVV2?\\b", RegexOption.IGNORE_CASE),
        Regex("\\bPIN\\b", RegexOption.IGNORE_CASE),
        Regex("one[-\\s]?time", RegexOption.IGNORE_CASE),
        Regex("verification\\s*code", RegexOption.IGNORE_CASE)
    )

    /**
     * Normalised the same way the server normalises, so a spelling difference
     * cannot slip past one and not the other. «رمز پويا» with the Arabic ي is
     * the same two words; a filter that only knows one spelling is not a
     * filter.
     */
    fun normalise(raw: String): String = raw
        // Bidi and zero-width marks the SMS app inserts around Latin digits.
        .replace(Regex("[​-‏‪-‮⁦-⁩﻿]"), "")
        .replace(Regex("[يى]"), "ی")   // ي ى → ی
        .replace("ك", "ک")                    // ك → ک
        .map { c ->
            when (c) {
                in '۰'..'۹' -> ('0' + (c - '۰'))   // Persian digits
                in '٠'..'٩' -> ('0' + (c - '٠'))   // Arabic-Indic
                '٬' -> ','
                else -> c
            }
        }.joinToString("")
        .trim()

    fun isSensitive(rawBody: String): Boolean {
        val body = normalise(rawBody)
        return PATTERNS.any { it.containsMatchIn(body) }
    }
}
