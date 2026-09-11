package ir.prizequiz.forwarder

/**
 * WHOSE MESSAGES ARE EVEN LOOKED AT.
 *
 * A daily phone's inbox is mostly none of the game's business. Forwarding
 * everything and letting the server sort it out would mean the operator's
 * private messages sitting in a payments database, so the app reads only what
 * comes from a bank.
 *
 * The operator's own samples showed the sender is a NAME, not a number —
 * «sepah bank», «refah bank», «tejarat bank» — which is why this matches
 * text rather than shortcodes. A numeric sender is matched too, for a bank
 * that uses one.
 *
 * Unknown senders are not an error and not a queue: they are simply not this
 * app's business, and nothing about them is recorded.
 */
object BankSenders {

    /* Lower-cased, matched as a substring, so «SEPAH BANK» and
     * «sepahbank» and «+98SEPAH BANK» all count as the same sender. */
    private val KNOWN = listOf(
        "sepah", "refah", "tejarat",
        "melli", "mellat", "saderat", "parsian", "pasargad", "saman",
        "ayandeh", "eghtesad", "shahr", "keshavarzi", "postbank", "sina",
        "بانک"
    )

    fun isBank(sender: String?): Boolean {
        val s = SensitiveFilter.normalise(sender ?: "").lowercase()
        if (s.isBlank()) return false
        return KNOWN.any { s.contains(it) }
    }
}
