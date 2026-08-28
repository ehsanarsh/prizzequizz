# به‌روزرسانی بعد از نصب اولیه

نصب اولیه با `install-site.sh` انجام می‌شود. این فایل فقط دربارهٔ **به‌روزرسانی**
است — همان‌جایی که یک بار اشتباه شد و چند روز طول کشید تا معلوم شود چرا هیچ
تغییری دیده نمی‌شود.

## سایت معرفی (pz-site)

سرویس داخل یک کانتینر اجرا می‌شود، با این تعریف در `install-site.sh`:

    -v /home/ubuntu/pz-site:/app:ro   -w /app   node /app/dist/server.js

یعنی کانتینر از **`/home/ubuntu/pz-site/dist/`** می‌خواند، نه از خود
`/home/ubuntu/pz-site/`. اگر فایل‌ها یک پله بالاتر باز شوند، روی دیسک عوض
می‌شوند و سرویس همچنان نسخهٔ قدیمی را اجرا می‌کند — و هیچ خطایی هم داده
نمی‌شود. صفحه باز می‌شود، کار می‌کند، و قدیمی است.

بستهٔ به‌روزرسانی با پیشوند `dist/` ساخته می‌شود تا این اشتباه ممکن نباشد:

    tar -czf pz-site-dist.tgz -C prizzequizz-site dist

و روی سرور:

    sudo tar -xzf ~/pz-site-dist.tgz -C /home/ubuntu/pz-site --overwrite
    sudo docker restart pz-site

بررسی اینکه واقعاً نشست — شمارهٔ نسخهٔ پنل باید عوض شده باشد:

    curl -sI https://prizzequizz.com/site-admin | grep -i x-site-build

`assets/` (فونت و کاراکترها) کنار `dist/` می‌ماند، در
`/home/ubuntu/pz-site/assets`، چون `assetDir()` از محل ماژول یکی بالاتر
می‌رود و آنجا را پیدا می‌کند.

## API بازی

    tar -czf pz-dist-contents.tgz -C prizzequizz-api/dist .

اینجا برعکس است: محتویات `dist` **بدون** پیشوند باز می‌شوند، چون مقصد خودش
`pz-dist` است:

    sudo tar -xzf ~/pz-dist-contents.tgz -C /home/ubuntu/pz-dist --overwrite
    sudo docker compose -p prizzequizz restart api

## بازی و پنل بازی

    sudo cp ~/prizze-v643.html /var/www/prizequiz/index.html
    sudo cp ~/pzadmin.html     /var/www/prizequiz/pzadmin.html

فایل ثابت است و nginx مستقیم سرو می‌کند؛ ری‌استارتی لازم نیست.
