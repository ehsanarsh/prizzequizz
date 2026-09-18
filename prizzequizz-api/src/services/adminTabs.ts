/* THE PANEL'S SCREENS, AS KEYS.
   Its own module so that roles can read it and accounts can read roles without
   the two importing each other in a circle. Kept in sync with the admin nav —
   a key here that the panel does not have is a permission nobody can use, and
   a screen the panel has that is missing here cannot be granted at all. */
export const ADMIN_TABS = [
  'dashboard', 'finance', 'accounting', 'expenses', 'backup', 'security', 'users', 'matches', 'support',
  'questions', 'qreports', 'aistudio', 'pipeline', 'categories', 'shop', 'characters', 'charboxes', 'lifelines', 'onboarding', 'lastsurvivor', 'sms', 'smsgroups', 'payments',
  'wallet', 'withdrawals', 'payoutpartners', 'withdrawotp', 'rewardholds', 'tickets', 'giftcodes',
  /* Every movement of money, itemised — its own permission because a list of
     who paid what is not the same thing as a dashboard of totals. */
  'ledger',
  'cfg_xp', 'cfg_level', 'cfg_cup', 'cfg_gameplay', 'leagues', 'missions', 'rewards',
  'leaderboard', 'campaign', 'events', 'banners', 'notifications',
  'anticheat', 'suspicious', 'reports', 'logs', 'reset', 'roles', 'accounts', 'general', 'rawcfg', 'monitoring',
  /* The programmers' queue: what actually broke on a player's phone. */
  'errors'
] as const;
