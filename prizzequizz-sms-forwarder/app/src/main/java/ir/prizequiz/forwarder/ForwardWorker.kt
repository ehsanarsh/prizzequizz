package ir.prizequiz.forwarder

import android.content.Context
import android.os.PowerManager
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * SENDING, AND KEEPING ON SENDING.
 *
 * WorkManager rather than a foreground service or a bare thread, because this
 * is the operator's daily phone: the process will be killed, the device will
 * sleep, and it will reboot. WorkManager survives all three and re-runs the
 * job when there is network again. A thread would lose the deposit; a
 * foreground service would fight the OS and still lose.
 *
 * TWO JOBS, AND THEY ARE DIFFERENT:
 *
 *   the immediate send   scheduled when an SMS arrives; retries with backoff
 *   the periodic sweep   every 15 minutes regardless, which is the shortest
 *                        period Android allows
 *
 * The sweep is not belt-and-braces. On a daily phone the immediate job is the
 * one Doze defers, so the periodic one is what actually gets a deposit
 * through overnight — and it is also the heartbeat, which is how the panel
 * learns the phone went quiet.
 */
class ForwardWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val credentials = Credentials(applicationContext)
        if (!credentials.isPaired) return Result.success()   // nothing to send anywhere yet

        val queue = Queue(applicationContext)
        val api = ApiClient(credentials)

        try {
            /* Batched, capped at what the server accepts. A phone back from a
             * long outage drains in several passes rather than one refused
             * request. */
            while (true) {
                val batch = queue.peek(BATCH)
                if (batch.isEmpty()) break
                val results = api.sendMessages(batch)
                val accepted = results.filterValues { it }.keys
                /* Removed only for what the SERVER confirmed. Anything else
                 * stays queued — a message we failed on is a deposit that has
                 * not been recorded, and dropping it loses real money. */
                queue.remove(accepted)
                if (accepted.size < batch.size) {
                    /* Some of the batch was refused. Retrying the whole thing
                     * immediately would spin; let the backoff handle it. */
                    return Result.retry()
                }
            }

            api.heartbeat(
                queueDepth = queue.depth(),
                batteryOptimized = isBatteryOptimized(applicationContext),
                lastSmsAt = queue.newestReceivedAt()
            )
            return Result.success()
        } catch (e: ApiClient.Unauthorised) {
            /* The server no longer knows us. Retrying cannot fix that and
             * would hide it: the operator has to re-pair from the panel. The
             * queue is KEPT — those deposits are still real, and they go out
             * the moment a new pairing lands. */
            Log.w(TAG, "device is no longer accepted; re-pair from the panel")
            return Result.failure()
        } catch (e: Exception) {
            Log.w(TAG, "send failed, will retry: ${e.message}")
            return Result.retry()
        }
    }

    companion object {
        private const val TAG = "ForwardWorker"
        private const val BATCH = 50
        private const val IMMEDIATE = "forward-now"
        private const val PERIODIC = "forward-sweep"

        private val onlyWhenOnline = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** A message just arrived. */
        fun enqueueNow(context: Context) {
            val work = OneTimeWorkRequestBuilder<ForwardWorker>()
                .setConstraints(onlyWhenOnline)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            /* APPEND, not REPLACE: replacing would cancel a send already in
             * flight for an earlier message and leave it queued behind a
             * newer one. */
            WorkManager.getInstance(context)
                .enqueueUniqueWork(IMMEDIATE, ExistingWorkPolicy.APPEND_OR_REPLACE, work)
        }

        /** The floor: fifteen minutes is the shortest Android will honour. */
        fun schedulePeriodic(context: Context) {
            val work = PeriodicWorkRequestBuilder<ForwardWorker>(15, TimeUnit.MINUTES)
                .setConstraints(onlyWhenOnline)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work)
        }

        /** What the panel shows as «بهینه‌سازی روشن» — the usual reason a
         *  daily-use phone stops forwarding. */
        fun isBatteryOptimized(context: Context): Boolean {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            return !pm.isIgnoringBatteryOptimizations(context.packageName)
        }
    }
}
