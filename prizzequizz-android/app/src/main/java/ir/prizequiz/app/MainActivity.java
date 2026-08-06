package ir.prizequiz.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

/**
 * The game is one self-contained page served over HTTPS, so the app is a shell
 * around it rather than a rewrite. That is a deliberate trade: every fix you
 * deploy to the site reaches the app immediately, with no store review.
 *
 * What the shell has to get right is the handful of things a bare WebView does
 * badly — the back button, file uploads, links that should leave the app, and
 * being offline — which is what this class is.
 */
public class MainActivity extends AppCompatActivity {

    private WebView web;
    private LinearLayout offline;
    private ValueCallback<Uri[]> filePicker;
    private static final int FILE_PICK = 1001;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        setContentView(web);
        buildOfflineView();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the game keeps its session here
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // answer sounds
        s.setSupportMultipleWindows(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Identify the shell so the server can tell app traffic from browser.
        s.setUserAgentString(s.getUserAgentString() + " PrizzeQuizzApp/1.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            /* Keep the game inside the app; send anything else — a payment
             * gateway, a support link, a social profile — to the real browser,
             * where the user can see the address bar. Money should never be
             * typed into a window with no URL on it. */
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                if (host.endsWith("prizequiz.ir")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                // Only the main document failing is worth a whole error screen.
                if (req.isForMainFrame()) showOffline();
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (isOnline()) hideOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /* Choosing an avatar. Without this the file input silently does
             * nothing, which looks like a broken button. */
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePicker != null) filePicker.onReceiveValue(null);
                filePicker = cb;
                try {
                    startActivityForResult(params.createIntent(), FILE_PICK);
                } catch (Exception e) {
                    filePicker = null;
                    return false;
                }
                return true;
            }

            /* The game asks for the microphone/camera only if a feature needs
             * it; grant what the page requests and Android has already allowed. */
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });

        /* The system back button walks the page's own history first, and only
         * closes the app at the start. Without this, back drops out of a match. */
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web.canGoBack()) web.goBack();
                else finish();
            }
        });

        if (isOnline()) web.loadUrl(getString(R.string.site_url));
        else showOffline();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != FILE_PICK) return;
        if (filePicker == null) return;
        filePicker.onReceiveValue(
            (res == Activity.RESULT_OK && data != null)
                ? WebChromeClient.FileChooserParams.parseResult(res, data)
                : null);
        filePicker = null;
    }

    private boolean isOnline() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return true;                      // do not block on a bad answer
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            NetworkCapabilities c = cm.getNetworkCapabilities(cm.getActiveNetwork());
            return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        }
        return cm.getActiveNetworkInfo() != null && cm.getActiveNetworkInfo().isConnected();
    }

    /** A plain Persian error screen, so being offline is not a blank white page. */
    private void buildOfflineView() {
        offline = new LinearLayout(this);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(android.view.Gravity.CENTER);
        offline.setBackgroundColor(getResources().getColor(R.color.pz_bg, getTheme()));
        offline.setPadding(48, 48, 48, 48);
        offline.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText(R.string.offline_title);
        title.setTextSize(20);
        title.setTextColor(getResources().getColor(R.color.pz_ink, getTheme()));
        title.setGravity(android.view.Gravity.CENTER);

        TextView body = new TextView(this);
        body.setText(R.string.offline_body);
        body.setTextSize(15);
        body.setTextColor(0xFFBDB6CE);
        body.setGravity(android.view.Gravity.CENTER);
        body.setPadding(0, 24, 0, 32);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(v -> {
            if (isOnline()) { hideOffline(); web.loadUrl(getString(R.string.site_url)); }
        });

        offline.addView(title);
        offline.addView(body);
        offline.addView(retry);
        addContentView(offline, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));
    }

    private void showOffline() { offline.setVisibility(View.VISIBLE); web.setVisibility(View.GONE); }
    private void hideOffline() { offline.setVisibility(View.GONE); web.setVisibility(View.VISIBLE); }

    @Override protected void onPause()  { super.onPause();  web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
}
