# پشتیبان‌گیری و بازگردانی دیتابیس

## نصب (یک‌بار)

دو فایل `backup-db.sh` و `install-backup.sh` را کنار هم روی سرور بگذار و:

```
sudo bash ~/install-backup.sh
```

همان لحظه یک پشتیبان می‌گیرد. اگر شکست خورد، **همان‌جا می‌فهمی** — نه ساعت چهار
صبحِ شبی که کسی نگاه نمی‌کند.

از آن به بعد هر شب ساعت ۴ اجرا می‌شود و ۱۴ نسخهٔ آخر را نگه می‌دارد.

## چک کردن

```
systemctl list-timers prizzequizz-backup.timer --no-pager
ls -la /home/ubuntu/pz-backups
sudo journalctl -u prizzequizz-backup -n 30 --no-pager
```

آخرین اجرا باید `ok — N backup(s) on hand` داشته باشد.

## یک‌بار تست بازگردانی — این را حتماً انجام بده

پشتیبانی که هیچ‌وقت بازگردانده نشده، پشتیبان نیست؛ فایلی است که امیدواری کار کند.
این تست روی یک دیتابیس **موقت** انجام می‌شود و به دادهٔ واقعی دست نمی‌زند:

```
cd /home/ubuntu && LATEST=$(ls -t pz-backups/pz-*.dump | head -1) && echo "testing $LATEST" && sudo docker compose -p prizzequizz exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS pz_restore_test" && sudo docker compose -p prizzequizz exec -T postgres psql -U postgres -c "CREATE DATABASE pz_restore_test" && sudo docker compose -p prizzequizz exec -T postgres pg_restore -U postgres -d pz_restore_test --no-owner < "$LATEST" && sudo docker compose -p prizzequizz exec -T postgres psql -U postgres -d pz_restore_test -c "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM wallet_ledger) AS ledger"
```

باید تعداد واقعی کاربرها و ردیف‌های دفتر کل را ببینی. بعد پاکش کن:

```
sudo docker compose -p prizzequizz exec -T postgres psql -U postgres -c "DROP DATABASE pz_restore_test"
```

## بازگردانیِ واقعی — وقتی چیزی از دست رفته

⚠️ این دادهٔ فعلی را **پاک می‌کند**. فقط وقتی که واقعاً چیزی خراب شده.

اول API را بخوابان تا وسط بازگردانی چیزی ننویسد:

```
cd /home/ubuntu && sudo docker compose -p prizzequizz stop api
```

نسخه را انتخاب کن و برگردان:

```
cd /home/ubuntu && LATEST=$(ls -t pz-backups/pz-*.dump | head -1) && echo "restoring $LATEST" && sudo docker compose -p prizzequizz exec -T postgres pg_restore -U postgres -d prizzequizz --clean --if-exists --no-owner < "$LATEST"
```

(برای نسخهٔ دیگری به‌جای `$LATEST` اسم فایل را بگذار — `ls -t pz-backups/`.)

بعد API را برگردان و چک کن:

```
cd /home/ubuntu && sudo docker compose -p prizzequizz start api && sleep 10 && curl -s -o /dev/null -w 'health=%{http_code}\n' https://www.prizequiz.ir/v1/health
```

## چیزی که این پشتیبان‌ها پوشش نمی‌دهند

**روی همان دیسکِ دیتابیس هستند.** این جلوی حذف تصادفی، مهاجرت خراب و از بین
رفتن volume را می‌گیرد — ولی جلوی از دست رفتنِ خودِ ماشین را نه.

برای آن باید یک نسخه از سرور بیرون برود. ساده‌ترین راه، از کامپیوتر خودت:

```
rsync -av --delete ubuntu@SERVER:/home/ubuntu/pz-backups/ ~/pz-backups/
```

هفته‌ای یک‌بار هم کافی است. اگر خواستی خودکارش کنم بگو.

## `.env` را هم جایی نگه دار

در `/home/ubuntu/.env` چیزهایی هست که **از دیتابیس بازنمی‌گردند**:

- `DEVICE_SECRET_KEY` — اگر گم شود، رمزِ همهٔ دستگاه‌های ثبت‌شده غیرقابل‌خواندن
  می‌شود و همه باید از نو ثبت شوند
- `VAPID_PRIVATE_KEY` — گم شود، همهٔ اشتراک‌های نوتیفیکیشن باطل می‌شوند
- `ADMIN_KEY`

یک کپی رمزگذاری‌شده جای امن نگه دار. **این فایل عمداً در پشتیبان خودکار نیست**:
دامپ دیتابیس چیزی است که ممکن است جابه‌جا یا دانلود شود، و راز نباید همراهش سفر
کند.
