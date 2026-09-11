package ir.prizequiz.forwarder

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ir.prizequiz.forwarder.databinding.ActivityMainBinding
import kotlin.concurrent.thread

/**
 * THE ONLY SCREEN.
 *
 * The app has one job and the operator opens it roughly twice: once to pair,
 * and again when the panel says it went quiet. So the screen answers exactly
 * the questions those two visits ask — am I paired, is anything stuck, and is
 * Android allowed to sleep me.
 *
 * THE BATTERY PROMPT IS NOT OPTIONAL FURNITURE. This is the operator's daily
 * phone; without the exemption Android WILL defer the send, and a deposit
 * arriving three hours late is a player who was told their payment failed. So
 * it is the loudest thing here whenever it is not granted.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var credentials: Credentials

    private val askSms = registerForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        credentials = Credentials(this)

        binding.pairButton.setOnClickListener { pair() }
        binding.smsPermissionButton.setOnClickListener { askSms.launch(Manifest.permission.RECEIVE_SMS) }
        binding.batteryButton.setOnClickListener { askBatteryExemption() }

        ForwardWorker.schedulePeriodic(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun refresh() {
        val hasSms = ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) ==
            PackageManager.PERMISSION_GRANTED
        val optimised = ForwardWorker.isBatteryOptimized(this)
        val depth = Queue(this).depth()

        binding.pairedStatus.text = if (credentials.isPaired)
            getString(R.string.paired_yes, credentials.deviceId?.take(8) ?: "")
        else getString(R.string.paired_no)
        binding.pairGroup.visibility = if (credentials.isPaired) android.view.View.GONE else android.view.View.VISIBLE

        binding.smsStatus.text = if (hasSms) getString(R.string.sms_ok) else getString(R.string.sms_missing)
        binding.smsPermissionButton.visibility = if (hasSms) android.view.View.GONE else android.view.View.VISIBLE

        /* The loudest line on the screen while it is wrong. */
        binding.batteryStatus.text = if (optimised) getString(R.string.battery_bad) else getString(R.string.battery_ok)
        binding.batteryButton.visibility = if (optimised) android.view.View.VISIBLE else android.view.View.GONE

        binding.queueStatus.text = if (depth == 0) getString(R.string.queue_empty)
        else getString(R.string.queue_pending, depth)
    }

    private fun pair() {
        val code = binding.pairingCode.text.toString().trim()
        if (code.length != 6) { binding.pairResult.text = getString(R.string.pair_code_length); return }
        binding.pairResult.text = getString(R.string.pairing)
        thread {
            val message = try {
                val (deviceId, secret) = ApiClient(credentials).pair(code, Build.MODEL ?: "phone")
                credentials.save(deviceId, secret)
                /* Anything that queued up before pairing goes out now. */
                ForwardWorker.enqueueNow(this)
                getString(R.string.pair_ok)
            } catch (e: Exception) {
                getString(R.string.pair_failed)
            }
            runOnUiThread { binding.pairResult.text = message; refresh() }
        }
    }

    private fun askBatteryExemption() {
        /* Opening the system dialog directly rather than dumping the operator
         * in Settings to find it: on most OEM skins it is three screens deep
         * and named something different on each. */
        startActivity(Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:$packageName")
        ))
    }
}
