-- Creates load-test students for tests/load/student-journey.js (docs/guides/testing.md).
--
-- STAGING OR CI ONLY. Never run this against production: it adds fake children
-- to a real family.
--
-- Make one parent and one child through the app first (sign up, add a child with
-- a PIN). This script clones that child into `count` students named load-0001,
-- load-0002, … in the same family, with the same PIN and a copy of the consent.
-- Running it again adds only the missing ones.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v family_code=ABCD2345 \
--     -v template_nickname=Dilya -v count=500 -f tests/load/prepare-students.sql
\set QUIET on
BEGIN;

CREATE TEMP TABLE load_template ON COMMIT DROP AS
SELECT l.parent_id, l.child_id, u.first_name, u.locale, p.grade, p.pin_hash, c.policy_version,
       c.scopes, c.method, c.evidence
FROM family_codes f
JOIN parent_child_links l ON l.parent_id = f.parent_id
JOIN student_profiles p ON p.user_id = l.child_id
JOIN users u ON u.id = l.child_id
JOIN consents c ON c.id = l.consent_id
WHERE f.code = upper(:'family_code')
  AND lower(p.nickname) = lower(:'template_nickname')
  AND u.deleted_at IS NULL;

DO $$
BEGIN
  IF (SELECT count(*) FROM load_template) <> 1 THEN
    RAISE EXCEPTION 'template child not found: check family_code and template_nickname';
  END IF;
END $$;

CREATE TEMP TABLE load_new ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, gen_random_uuid() AS consent_id,
       'load-' || lpad(n::text, 4, '0') AS nickname
FROM generate_series(1, :count) AS n
WHERE NOT EXISTS (
  SELECT 1 FROM parent_child_links l
  JOIN student_profiles p ON p.user_id = l.child_id
  WHERE l.parent_id = (SELECT parent_id FROM load_template)
    AND p.nickname = 'load-' || lpad(n::text, 4, '0')
);

INSERT INTO users (id, first_name, locale)
SELECT n.id, t.first_name, t.locale FROM load_new n CROSS JOIN load_template t;

INSERT INTO user_roles (user_id, role) SELECT id, 'student' FROM load_new;

INSERT INTO student_profiles (user_id, nickname, nickname_status, grade, pin_hash)
SELECT n.id, n.nickname, 'approved', t.grade, t.pin_hash FROM load_new n CROSS JOIN load_template t;

INSERT INTO consents (id, parent_id, child_id, policy_version, scopes, method, evidence)
SELECT n.consent_id, t.parent_id, n.id, t.policy_version, t.scopes, t.method,
       t.evidence || '{"loadTest": true}'
FROM load_new n CROSS JOIN load_template t;

INSERT INTO parent_child_links (parent_id, child_id, consent_id)
SELECT t.parent_id, n.id, n.consent_id FROM load_new n CROSS JOIN load_template t;

SELECT count(*) || ' students added' AS result FROM load_new;
COMMIT;
