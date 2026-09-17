-- THE FOUR THAT PLAYED WITHOUT A NAME — WHICH FIELD IS ACTUALLY MISSING?
--
-- The first query folded two very different states into one `ghost` flag with
-- an OR, so «no display name» and «no username» came out looking the same:
--
--   · BOTH placeholder  → they never completed registration at all, and yet
--                         got into the game. A hole in the flow.
--   · name set, username still user_…  → submitRegister DID run and only half
--                         of it stuck. A bug in the save.
--
-- These need opposite fixes, so they have to be told apart before anything is
-- built. `gender` is the tell: nothing sets it except the registration form, so
-- a row that has one went through that screen and pressed the button.
--
-- Four rows of states and counts. No names, no usernames, no phone numbers.
SELECT
  CASE WHEN coalesce(u.display_name,'') = '' THEN 'empty'
       WHEN u.display_name = 'بازیکن جدید'   THEN 'placeholder'
       ELSE 'real' END                                   AS display_name_state,
  CASE WHEN u.username ~ '^user_[0-9]+$' THEN 'placeholder' ELSE 'real' END AS username_state,
  (u.gender IS NOT NULL AND u.gender <> '')              AS went_through_form,
  COALESCE(mp.played, 0)                                 AS played,
  COALESCE(sp.spent, 0)                                  AS spent,
  u.created_at::date                                     AS created,
  u.updated_at::date                                     AS last_touched,
  (u.updated_at > u.created_at + interval '2 minutes')   AS edited_after_signup
FROM users u
LEFT JOIN (SELECT user_id, count(*) AS played
             FROM match_players GROUP BY user_id) mp ON mp.user_id = u.id
LEFT JOIN (SELECT user_id, SUM(amount) AS spent
             FROM transactions
            WHERE direction = 'debit' AND currency = 'cash'
            GROUP BY user_id) sp ON sp.user_id = u.id
WHERE ( coalesce(u.display_name,'') = ''
        OR u.display_name = 'بازیکن جدید'
        OR u.username ~ '^user_[0-9]+$' )
  AND (COALESCE(mp.played,0) > 0 OR COALESCE(sp.spent,0) > 0)
ORDER BY u.created_at;
