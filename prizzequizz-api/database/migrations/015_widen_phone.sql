-- Match-save upserts placeholder user rows with phone = 'mock-' || <uuid> (41 chars),
-- which overflowed phone VARCHAR(32) and made every match-save fail on real users.
ALTER TABLE users ALTER COLUMN phone TYPE VARCHAR(64);
