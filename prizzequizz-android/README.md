# اپلیکیشن اندروید پرایز کوئیز

پوسته‌ای دور بازی: صفحهٔ بازی را از `https://www.prizequiz.ir` باز می‌کند.

**چرا پوسته و نه بازنویسی؟** بازی یک فایل HTML خودبسنده است که روی سرور تو سرو می‌شود. با این روش هر اصلاحی که روی سایت منتشر می‌کنی بلافاصله به اپ می‌رسد — بدون بازبینی فروشگاه، بدون نسخهٔ جدید. چیزی که پوسته باید درست انجام دهد چند چیز است که WebView خام بد انجام می‌دهد: دکمهٔ برگشت، آپلود فایل، لینک‌هایی که باید از اپ بیرون بروند، و حالت آفلاین.

---

## ساخت APK

> **این پروژه در محیط من ساخته نمی‌شود** — آنجا Android SDK نیست و دانلودش از پروکسی مسدود است. باید روی ماشین خودت ساخته شود.

### راه ۱ — Android Studio (ساده‌ترین)

1. [Android Studio](https://developer.android.com/studio) را نصب کن
2. `File → Open` و پوشهٔ `prizzequizz-android` را باز کن
3. صبر کن تا Gradle همگام شود (بار اول چند دقیقه)
4. `Build → Build Bundle(s) / APK(s) → Build APK(s)`

فایل ساخته‌شده:
```
app/build/outputs/apk/debug/app-debug.apk
```

### راه ۲ — خط فرمان

نیاز: JDK 17+ و Android SDK (متغیر `ANDROID_HOME`).

```bash
cd prizzequizz-android
./gradlew assembleDebug      # نسخهٔ تست
./gradlew assembleRelease    # نسخهٔ انتشار
```

اگر `gradlew` نبود، یک‌بار در پوشه بزن:
```bash
gradle wrapper --gradle-version 8.7
```

---

## امضا کردن برای انتشار

بدون امضا، APK نصب می‌شود ولی در کافه‌بازار/مایکت پذیرفته نمی‌شود.

```bash
keytool -genkey -v -keystore prizequiz.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias prizequiz
```

بعد فایل `app/keystore.properties` بساز:

```properties
storeFile=/absolute/path/prizequiz.jks
storePassword=رمزی که گذاشتی
keyAlias=prizequiz
keyPassword=رمزی که گذاشتی
```

`./gradlew assembleRelease` خودش برش می‌دارد.

⚠️ **این فایل و کلید را هرگز در مخزن نگذار.** کلیدی که لو برود کلیدی است که باید عوضش کنی — و عوض کردن کلید یعنی همهٔ کاربرها باید اپ را حذف و دوباره نصب کنند. `.gitignore` جلویش را می‌گیرد.

---

## چیزهایی که باید بدانی

**اعلان پوش کار نمی‌کند.** بازی از Web Push استفاده می‌کند و WebView از آن پشتیبانی نمی‌کند. دو راه دارد:

- **Trusted Web Activity (TWA)** به‌جای WebView — پوش و رفتار PWA حفظ می‌شود، ولی باید `assetlinks.json` روی دامنه بگذاری
- **افزودن Firebase Cloud Messaging** به اپ — کار بیشتری است و سمت سرور هم تغییر می‌خواهد

اگر پوش برایت مهم است بگو تا TWA را آماده کنم.

**لینک‌های بیرونی** — هر چیزی که دامنه‌اش `prizequiz.ir` نباشد در مرورگر واقعی باز می‌شود، نه داخل اپ. این عمدی است: درگاه پرداخت نباید در پنجره‌ای بدون نوار آدرس باز شود.

**دکمهٔ برگشت** اول در تاریخچهٔ خود صفحه عقب می‌رود و فقط در ابتدا از اپ خارج می‌شود — وگرنه وسط مسابقه بیرون می‌انداخت.

**آیکون** — الان آیکون پیش‌فرض است. تصویر خودت را در `app/src/main/res/mipmap-*` بگذار یا در Android Studio از `New → Image Asset` استفاده کن.

---

## تغییر نشانی سایت

در `app/src/main/res/values/strings.xml`:

```xml
<string name="site_url">https://www.prizequiz.ir/</string>
```
