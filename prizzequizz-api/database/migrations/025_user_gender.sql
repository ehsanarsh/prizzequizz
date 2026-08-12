-- Gender, asked once at sign-up and editable in the profile.
-- Nullable on purpose: everybody who already has an account has not been asked,
-- and "not said" is a real answer that must not be guessed at.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(12);
