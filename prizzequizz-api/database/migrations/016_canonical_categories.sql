-- Normalize every question's category into the 12 canonical categories used
-- across the app (UI, matchmaking, category selection). Best-effort mapping of
-- the existing seed categories; anything unmapped becomes "اطلاعات عمومی".
--
-- The 12 canonical categories:
--   اطلاعات عمومی، فوتبال، سینما و سریال، علم و دانش، تاریخ ایران، موسیقی،
--   ایران و جهان، ورزش، هوش و معما، تکنولوژی، تاریخ جهان، مذهبی

UPDATE questions SET category = 'علم و دانش'     WHERE category IN ('علوم', 'سلامت', 'زیست‌شناسی', 'فیزیک', 'شیمی');
UPDATE questions SET category = 'ایران و جهان'   WHERE category IN ('جغرافیا', 'ایران');
UPDATE questions SET category = 'تکنولوژی'       WHERE category IN ('فناوری');
UPDATE questions SET category = 'تاریخ جهان'     WHERE category IN ('تاریخ');
UPDATE questions SET category = 'هوش و معما'     WHERE category IN ('ریاضی', 'هندسه');
UPDATE questions SET category = 'سینما و سریال'  WHERE category IN ('هنر', 'سرگرمی');
UPDATE questions SET category = 'اطلاعات عمومی'  WHERE category IN ('دانستنی', 'ادبیات', 'فرهنگ', 'اقتصاد');
-- ورزش already canonical; leave as-is.

-- Anything still outside the 12 → General Knowledge (catch-all).
UPDATE questions SET category = 'اطلاعات عمومی'
WHERE category NOT IN (
  'اطلاعات عمومی','فوتبال','سینما و سریال','علم و دانش','تاریخ ایران','موسیقی',
  'ایران و جهان','ورزش','هوش و معما','تکنولوژی','تاریخ جهان','مذهبی'
);

-- Make sure the seeded questions are actually queryable (seed used 'active').
UPDATE questions SET status = 'approved' WHERE status = 'active';
