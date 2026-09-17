-- WHO ARE THE «بازیکن جدید» ROWS, REALLY?
--
-- Two completely different stories produce the same-looking row, and they need
-- opposite fixes:
--
--   A. Abandoned sign-ups. The account is created the MOMENT the SMS code is
--      verified — before the name is ever asked for. Anyone who gets a code and
--      then closes the app leaves a row behind for ever. Nothing was lost;
--      the panel is simply showing people who never signed up.
--
--   B. Lost names. The player really did type a name and it did not stick.
--      That is data loss and a bug to hunt.
--
-- The number that separates them is `placeholder_but_active`: a row with no
-- name that has nevertheless PLAYED or SPENT money is somebody who got past the
-- registration screen — so their name should be there and is not.
--
-- Counts only. No names, no phone numbers, nothing about any one person.
SELECT
  count(*)                                                       AS total_users,
  count(*) FILTER (WHERE ghost)                                  AS placeholder_rows,
  count(*) FILTER (WHERE ghost AND played = 0 AND spent = 0)     AS placeholder_never_active,
  count(*) FILTER (WHERE ghost AND (played > 0 OR spent > 0))    AS placeholder_but_active,
  count(*) FILTER (WHERE NOT ghost)                              AS named_users,
  min(created_at) FILTER (WHERE ghost)                           AS oldest_placeholder,
  max(created_at) FILTER (WHERE ghost)                           AS newest_placeholder
FROM (
  SELECT u.id, u.created_at,
         ( coalesce(u.display_name,'') = ''
           OR u.display_name = 'بازیکن جدید'
           OR u.username ~ '^user_[0-9]+$' )        AS ghost,
         COALESCE(mp.played, 0)                     AS played,
         COALESCE(sp.spent, 0)                      AS spent
    FROM users u
    LEFT JOIN (SELECT user_id, count(*) AS played
                 FROM match_players GROUP BY user_id) mp ON mp.user_id = u.id
    LEFT JOIN (SELECT user_id, SUM(amount) AS spent
                 FROM transactions
                WHERE direction = 'debit' AND currency = 'cash'
                GROUP BY user_id) sp ON sp.user_id = u.id
) t;
