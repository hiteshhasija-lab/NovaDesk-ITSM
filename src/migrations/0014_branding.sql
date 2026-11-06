-- 0014 Branding: the product name, logo, accent colour and wording an organisation shows its people (src/branding.js).
--
-- One row, as scim_settings is. Every column that is empty means "the built-in NovaDesk look", so an install that never
-- opens the Branding page looks exactly as it did before. The logo is kept here (a few hundred kilobytes at most), so a
-- backup of the database is a backup of the branding and nothing has to be copied between servers.
-- logo_version is a short hash of the picture: it goes into the address of the logo so a changed logo is fetched afresh.
-- login_background is what is behind the sign-in card: the built-in photograph, a plain backdrop in the accent colour, or the
-- organisation's own picture (background, kept the same way as the logo).

CREATE TABLE branding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  product_name TEXT NOT NULL DEFAULT 'NovaDesk',
  accent_color TEXT,
  login_welcome TEXT,
  login_tagline TEXT,
  email_footer TEXT,
  logo BYTEA,
  logo_mime TEXT,
  logo_version TEXT,
  login_background TEXT NOT NULL DEFAULT 'builtin' CHECK (login_background IN ('builtin', 'plain', 'custom')),
  background BYTEA,
  background_mime TEXT,
  background_version TEXT,
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO branding_settings (id) VALUES (1);
