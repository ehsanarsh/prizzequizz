# PrizzeQuizz — the Android app

An installable APK/AAB, for listing the game on Cafe Bazaar.

## What this is

A **Trusted Web Activity**: the game stays the site at `https://prizequiz.ir`,
and the app is a full-screen shell around it.

That is a deliberate choice, not a shortcut. A TWA runs on the device's browser
engine, so **web push keeps working** — the notifications the game already
sends arrive exactly as they do now. The obvious alternative, a plain WebView
wrapper, is simpler and would have silently killed every one of them.

It also means **the app carries no copy of the game**. Deploying `index.html`
to the server updates the app for everyone; a new APK is only needed when
something here changes (icon, name, permissions).

## Building it

The build runs on GitHub's machines, which already have the Android SDK —
there is nothing to install locally.

1. Repository → **Actions** → **Build Android app** → **Run workflow**
2. Fill in the version (`1.0.0`) and version code (`1`)
3. When it finishes, download the **prizzequizz-android** artifact

Without a signing key it produces a **debug APK**: installable on a phone for
testing, but Bazaar will not accept it.

## The signing key — read this once, carefully

Bazaar accepts only a **release-signed** build, and every future update must be
signed with the **same key**. Lose it and the listing can never be updated
again — not by you, not by anyone. There is no recovery.

Generate it on your own machine and keep it somewhere safe:

```bash
keytool -genkeypair -v \
  -keystore prizzequizz-release.jks \
  -alias prizzequizz \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then add it to the repository as secrets — Settings → Secrets and variables →
Actions → New repository secret:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 prizzequizz-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password you chose |
| `ANDROID_KEY_ALIAS` | `prizzequizz` |
| `ANDROID_KEY_PASSWORD` | the key password you chose |

The key is never committed here, and never should be.

## Removing the URL bar (do this before publishing)

Until the domain vouches for the app, Android draws an address bar across the
top and the app looks like a browser with the game inside it.

1. Run the workflow once with signing configured. Its log prints the
   certificate's **SHA256** fingerprint.
2. Copy `assetlinks.template.json`, replace the placeholder with that
   fingerprint, and put it on the server:

```bash
sudo mkdir -p /var/www/prizequiz/.well-known
sudo nano /var/www/prizequiz/.well-known/assetlinks.json
```

3. Add the block from `nginx-assetlinks.conf` to the site's nginx config,
   `sudo nginx -t && sudo systemctl reload nginx`
4. Check: `curl -s https://prizequiz.ir/.well-known/assetlinks.json`
5. Reinstall the app — the bar should be gone.

## Before you upload to Bazaar

- **Version code must increase** on every upload (1, 2, 3 …)
- Package name is `ir.prizequiz.app`. Changing it later means a new listing, so
  decide now if you want something else.
- `store-icon-512.png` here is the 512×512 store icon.

## One thing to check with Bazaar first

If Bazaar requires their **own in-app billing** (بازارپی / IAB) for purchases
inside the app, a TWA cannot provide it — that needs their native SDK, which
only a real native app or a WebView wrapper with a bridge can host.

If instead you only need an APK to register the app and obtain a gateway, and
payments continue through the web flow the game already uses, this is enough.

Worth confirming before the build is submitted, because the answer changes what
the app has to be.
