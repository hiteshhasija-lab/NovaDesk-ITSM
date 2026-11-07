# NovaDesk ITSM

A ServiceNow-style IT Service Management app: Incident Management, Change Management, and a CMDB (server/asset inventory) — with role-based access (admin / agent / end user).

## Stack

- Node.js + Express, EJS server-rendered views, Bootstrap 5
- SQLite via Node's built-in `node:sqlite` module (no native build required) — requires **Node.js 22.5+** (24.x recommended)
- Session auth with bcrypt-hashed passwords, file-based session store

## Run it

You need Node.js 22 and a Postgres database (the defaults are `localhost`, user `novadesk`, database `novadesk`; set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` to change them).

```bash
npm install
npm run dev      # = SEED_DEMO=true node src/server.js: the demonstration workspace
```

Then open http://localhost:3000. The tables are created automatically, and on an empty database `npm run dev` also fills it with demo users, CMDB assets, incidents, changes, catalog items and articles.

## Settings

| Setting | |
|---|---|
| `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (`PGPORT`) | The database. **Required** when `NODE_ENV=production`; otherwise development defaults apply. |
| `SESSION_SECRET` | Signs sessions. **Required** when `NODE_ENV=production`: at least 32 characters, for example `openssl rand -hex 32`. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` (8+ characters), optional `ADMIN_FULL_NAME`, `ADMIN_EMAIL` | On an **empty** database, creates one administrator and nothing else. Used once: changing them later does not change an existing account. |
| `SEED_DEMO=true` | On an empty database, creates the demonstration workspace instead (see "Demo logins"). Never use it on a real installation. |

With neither `ADMIN_*` nor `SEED_DEMO` an empty database stays empty and the log says so. In production mode a missing database setting or session secret stops the start with a message naming it. Decommission requests from NovaConnect are assigned to the account named `admin`, or, if there is none, to the oldest active administrator.

## Fresh install (server)

One server running NovaDesk and Postgres with Docker Compose or Podman Compose, from a clone of this repository.

```bash
cp .env.example .env     # then fill in the "Required" part: database password, SESSION_SECRET, first admin
mkdir certs              # optional: certs/cert.pem + certs/key.pem make NovaDesk serve https as well
docker compose up -d --build        # or: podman compose up -d --build
docker compose logs novadesk        # "Created the first admin account ..."
```

Generate each secret with `openssl rand -hex 32` (hex only, so nothing needs quoting in `.env`). Open
`http://<server>/` and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`; change the password in
**Profile**. Those two settings are used once, on an empty database. There is no demonstration data
and no built-in account (`SEED_DEMO=true` is for demos only). The tables are created by NovaDesk
itself at start-up. The service catalog and knowledge base start empty; add what you need under
**Catalog** and **Knowledge Base**, and your people under **Users**.

Browsers do not need https for NovaDesk to work, but passwords then cross the network in clear text:
put a certificate in `certs/` (or a TLS proxy in front) for anything but a trial.

**Linking it to NovaConnect** (chat-driven decommissioning): set `NOVACONNECT_BASE_URL` (where this
server reaches NovaConnect) and `SYNC_API_KEY` in NovaDesk's `.env`, and on the NovaConnect side
`NOVADESK_BASE_URL` (where NovaConnect reaches NovaDesk), `NOVADESK_PUBLIC_URL` (the address people open)
and the **same** `SYNC_API_KEY`. Decommission requests are assigned to the account named `admin`, or
to the oldest active administrator if there is none; only the requester or members of the
*IRO-Build/Decom* group (the first admin is added automatically; manage it under **Users**) can
approve. **ESXi:** `ESXI_USER` and `ESXI_PASSWORD` must name an account that may power off and destroy
virtual machines on your hosts; without them the automation stops at the first ESXi step and says so.

**Email.** NovaDesk emails people about their tickets (assigned to you, a new comment, approved).
Set `SMTP_HOST` and `SMTP_FROM` in `.env`, plus `SMTP_USER` and `SMTP_PASSWORD` if your mail server needs a
sign-in (port 587 uses STARTTLS; for port 465 also set `SMTP_SECURE=true`), then restart NovaDesk. In
**Notifications**, an administrator can press *Send a test email to me*; every message NovaDesk sends or
fails to send is listed there with the reason. The password is never sent over an unencrypted connection.
Without `SMTP_HOST` a production install sends nothing: notices are listed as *Not sent*, and nothing
leaves the server. A mail server that is down never stops NovaDesk; the notice shows as *Failed*.

**SLA targets.** Each incident has a due time from its priority (P1 4 hours, P2 8, P3 24, P4 72 until you
change them). An administrator opens *SLA settings* (user menu) to set the target per priority, whether it
counts round the clock or only **business hours** (working days, daily start and end in a time zone, and
holidays), and the share of the target used before a warning goes out. The clock stops while an incident is
**On Hold** and the waiting time is added to the due time when it leaves On Hold. The assignee (or, with no
assignee, the assignment group, or the administrators) gets an email when an incident is at risk and another
when it is breached, once each; this needs email set up (above). A new target applies to incidents created
from then on and to incidents whose priority changes; a due time already running does not move.

**SLA for service requests and changes.** Under *SLA settings* an administrator can also switch on a target for
**service requests** (time to fulfil, from submission) and for **changes** (time to a decision while the change is
Submitted and waiting for approval). Both start switched off. Once on, only requests created and changes
submitted from then on get a clock, and the same warning and breach emails go out: for a request to its assignee
(or the assignment group, or the administrators); for a change to the people who may approve it (a
decommission change's requester and the IRO-Build/Decom group; any other change's assignee or group, or the
administrators). A change's clock is kept by watching its status, so approving, rejecting or cancelling it works
as before and stops the clock within a minute.

**Single sign-on.** NovaDesk can sign people in through your identity provider with OpenID Connect: Microsoft
Entra ID, Google Workspace, Okta, Keycloak and the like. At the provider, register an application ("web", code
flow) with the redirect address `https://<your NovaDesk>/auth/oidc/callback`, then set `PUBLIC_URL`, `OIDC_ISSUER`,
`OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` in `.env` (see `.env.example`; for Entra the issuer is
`https://login.microsoftonline.com/<tenant-id>/v2.0`, for Google `https://accounts.google.com`) and restart. The
login page then shows a *Sign in with…* button.
- A person is recognised by the provider's own id for them. The first time, an existing account is matched by
  email, but only if the provider says the email is verified (Google does; Entra does not, so for Entra set
  `OIDC_TRUST_EMAIL=true`, and only with your own tenant's issuer).
- Nobody is created by surprise: without `OIDC_AUTO_CREATE=true`, only people who already have an account can
  sign in. With it, an account (role `OIDC_DEFAULT_ROLE`, `user` or `agent`, never admin) is made on first sign-in.
  `OIDC_ALLOWED_DOMAINS` limits sign-in to your email domains.
- A turned-off account cannot sign in this way either. `LOCAL_LOGIN=false` removes the password form once single
  sign-on works (keep it on until you have tested, so you cannot lock yourself out).
- People who sign in through the provider answer to the provider's own multi-factor rules.

**Two-step verification.** Anyone can add a second step to signing in with their password: under the user menu,
*Two-step verification*, scan the QR code with an authenticator app (Microsoft Authenticator, Google Authenticator,
Authy, 1Password) or type the key shown beside it, confirm with a code, and keep the ten recovery codes shown once. The password then leads to a
code page. The QR code is drawn by NovaDesk itself (`src/qr.js`, no outside service, so the key never leaves the server)
and those pages are never cached. Each code works once; five wrong codes lock the code step for that person for ten minutes; a recovery code
works once. Whoever loses their phone and their recovery codes asks an administrator: *Users*, the person,
*Reset two-step verification*. `MFA_REQUIRE=admins` (or `all`) makes it compulsory: until it is set up, only its
setup page and sign-out open. The stored keys are encrypted with `MFA_ENCRYPTION_KEY` (default: derived from
`SESSION_SECRET`; if that changes without a fixed `MFA_ENCRYPTION_KEY`, people use a recovery code or get a reset).

**REST API.** Scripts and other systems can read and create incidents, service requests and configuration items
through `/api/v1`, with a personal API key. Each person makes keys under the user menu, *API keys* (shown once;
read-only or read and write; they expire after 30 days, 90 days, a year or never; ten at most). A key acts as its
owner, with the owner's role: end users see only their own incidents and requests. The guide, with examples, is at
`/api/docs` and the OpenAPI document at `/api/v1/openapi.json`. Changes, approvals and the decommission workflow
are read-only in the API. A leaked key can be revoked by its owner, or by an administrator for all of a person's
keys (*Users*, the person, *Revoke all API keys*). Keys are not covered by two-step verification, like any token.
Writes made through the API run the same rules as the pages (SLA clocks, activity log, emails).
- Rate limits: `RATE_LIMIT_API_PER_MIN` (default 300) reads and `RATE_LIMIT_API_WRITE_PER_MIN` (default 60) writes
  per key per minute, and `RATE_LIMIT_IP_PER_MIN` (default 1200) for every page and API route per address; `0`
  turns one off. Answers carry `X-RateLimit-*` headers and, over the limit, `429` with `Retry-After`.
- Behind a reverse proxy set `TRUST_PROXY` to the number of proxies (for example `1`), otherwise every client shares
  the proxy's address and its limits.
- Send an `Idempotency-Key` header with a `POST` to make a retry safe.

**Webhooks.** An administrator (user menu, *Webhooks*) can have NovaDesk call an address whenever incidents,
changes, problems, service requests, configuration items or knowledge articles are created, changed, move to
another status or (incidents, changes, problems) get a comment. The call is a JSON `POST` carrying the record
exactly as the API shows it, signed with the webhook's secret (`X-NovaDesk-Signature`, HMAC-SHA256 over the time and
the body); the guide at `/api/docs#webhooks` has the payload, the headers and a check in Node and Python. Events are
recorded by the database itself, so every route that changes a record is covered, including the integrations and the
decommission automation; internal work notes are never sent. A receiver must answer `2xx` within 10 seconds; a failed
call is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then given up, and the log shows each try
with the reason and a Retry button. A receiver whose last 10 deliveries all failed is switched off
(`WEBHOOK_AUTO_DISABLE_AFTER`). Only `https://` addresses that resolve to public addresses are accepted, redirects are
not followed, and the call connects only to the address that was checked; `WEBHOOK_ALLOW_PRIVATE=true` allows private
addresses and plain http for a receiver inside your network.
The signing secrets are stored encrypted with `MFA_ENCRYPTION_KEY` (default: derived from `SESSION_SECRET`), so if you
change `SESSION_SECRET` without a fixed `MFA_ENCRYPTION_KEY`, press *New secret* on each webhook.

**Upgrading:** `git pull`, then `docker compose up -d --build --force-recreate novadesk` (or
`podman compose …` with the same options). `--force-recreate` matters on Podman: podman-compose
rebuilds the image but leaves the running container on the old one without it. The database and the
data volume keep their contents; table changes are numbered migrations (`src/migrations/`) that NovaDesk
applies itself when it starts, once each, all or nothing. `docker compose exec novadesk node src/migrate.js
status` lists them. Back up first (below).

**Backups.** Two things hold your data: the database and the data volume (attachments and
the Decommissioned Tracker workbook). Sign-in sessions live in the database. Use your own database user in place of `novadesk` if you changed `PGUSER`.

```bash
docker compose exec -T postgres pg_dump -U novadesk -Fc novadesk < /dev/null > novadesk.dump
docker compose exec -T novadesk tar -C /app/data -cf - . < /dev/null > appdata.tar
```

Keep both files, plus `.env` and `certs/`, somewhere off the server. (`< /dev/null` matters inside a
script: `compose exec` otherwise swallows the rest of the script as its input.)

**Restore** onto an empty install (same `.env`). The order matters: the data goes in *before* NovaDesk
starts, or it would see an empty database and create a new first admin that the restore would clash with.

```bash
docker compose up -d postgres                  # the database only, empty; give it ~15 s to initialise
docker compose exec -T postgres pg_restore -U novadesk -d novadesk --no-owner --no-privileges --exit-on-error < novadesk.dump
docker compose run --rm --no-deps -T --entrypoint tar novadesk -C /app/data -xf - < appdata.tar
docker compose up -d novadesk
```

`--no-privileges` matters: the dump names the database role the application switches to (`novadesk_app`, see *Several
organisations on one installation*), which does not exist on a new server; NovaDesk creates it and grants what it needs
when it starts.

Sessions are part of the data volume, so people whose session was in the backup stay signed in and
everyone else signs in again. With Podman, use `podman compose`.

**Host notes**
- *Podman Compose on RHEL:* `podman compose` needs a provider; `podman-compose` is in EPEL.
- *Rootless Podman:* binding ports 80/443 needs `sysctl net.ipv4.ip_unprivileged_port_start=0`
  (or set `NOVADESK_HTTP_PORT` / `NOVADESK_HTTPS_PORT` above 1024). Containers do not come back after
  a reboot on their own: run once, as the user that owns them, `systemctl --user enable podman-restart.service`
  and `sudo loginctl enable-linger $USER`. Docker restarts them itself (`restart: unless-stopped`).
- *Next to NovaConnect on the same server:* both default to ports 80/443. Give each its own address
  (`NOVADESK_BIND_IP` / `NOVACONNECT_BIND_IP`) or its own ports.
- *SELinux (RHEL, Fedora):* `compose.yaml` mounts `certs/` with `:z` so the container can read it.
  Don't mount this whole folder into other containers with `:Z`.
- *The image* is built on the machine it runs on: the `govc` tool for ESXi is fetched for that
  machine's CPU (x86-64 or ARM64) while building, so the build needs internet access.

## Demo logins (`SEED_DEMO=true` only)

| Username | Password  | Role  | Notes |
|----------|-----------|-------|-------|
| admin    | admin123  | admin | Full access, user management |
| jdoe     | agent123  | agent | Infrastructure Support |
| bsmith   | agent123  | agent | Network Operations |
| mchen    | user123   | user  | End user — sees only their own tickets |
| rpatel   | user123   | user  | End user |

## Modules

- **Incidents** — impact/urgency-driven priority (P1–P4), assignment, work notes vs. customer-visible comments, CI linkage, full lifecycle (New → In Progress → Resolved → Closed).
- **Changes** — standard/normal/emergency types, risk levels, approval workflow (submit → approve/reject → scheduled → implemented → closed), implementation/backout plans.
- **CMDB** — servers, network devices, applications, databases, workstations, storage. Tracks IP, OS, hardware specs, location, owner, warranty/lifecycle dates, and CI-to-CI relationships (depends on / runs on / connects to). Related incidents and changes show up on each CI's page.
- **Users** — admin-only user management with roles and departments.
- **Import** — users, configuration items and knowledge articles from a CSV file, with a preview before anything is saved (see *Importing data*).
- **Privacy** — download everything held about a person, anonymise a person who has left, and set how long logs and messages are kept (see *Privacy tools*).
- **SCIM** — an identity provider creates, changes and switches off people by itself (see *SCIM provisioning*).
- **Custom fields** — the extra fields an organisation wants on incidents, requests, changes, problems and configuration items (see *Custom fields*).
- **Tenants** — several organisations on one installation, kept apart by the database (see *Several organisations on one installation*).
- **Branding** — your own product name, logo, colour, sign-in picture and wording, instead of NovaDesk's (see *Branding*).

## Inbound email

Mail sent to the help desk's address becomes an incident, and a reply to one of NovaDesk's notices becomes a comment on
its incident. Everything it looks at is listed, with what was done and why, under the user menu, *Settings*, *Inbound
email* (administrators). Off until you set one of the two ways in; every setting is in `.env.example`.

**Reading a mailbox (IMAP).** Give NovaDesk a mailbox of its own (`INBOUND_IMAP_HOST`, `INBOUND_IMAP_USER`,
`INBOUND_IMAP_PASSWORD`). Every `INBOUND_POLL_SECONDS` (60) it reads the unread messages, handles each, and marks it read
(or moves it to `INBOUND_PROCESSED_FOLDER`). A message that cannot be handled because something was down stays unread
and is tried again, three times, then it is written down as failed so it cannot hold up the others. Set `SMTP_FROM` (or
`INBOUND_ADDRESS`) to that mailbox's address: notices then carry it as Reply-To and replies come back to it.
**Microsoft 365 no longer accepts a password for IMAP** and Google needs an app password: for those, use the second way
(a mail flow rule, Power Automate, or an inbound-mail service such as Postmark or Mailgun posts to NovaDesk), or a mailbox on
your own domain.

**Handed over (HTTP).** With `INBOUND_SECRET` set, `POST /api/inbound/email` takes one raw email as the body
(`Content-Type: message/rfc822`) with `Authorization: Bearer <secret>`, and answers `202` with what was done
(`outcome`: `ticket`, `comment`, `ignored`, `rejected`, or `duplicate`). A `5xx` means send it again.

**What happens to a message**
- It is looked at once: the same message arriving twice (a mailbox read again, a mail system that retries) never makes
  two incidents.
- **Not answered:** mail from NovaDesk's own address, automatic mail (out-of-office, bounces, newsletters, mailing
  lists, anything marked `Auto-Submitted`), senders on `INBOUND_BLOCKED_SENDERS`, mail the receiving server says is
  forged (a failed DMARC, SPF or DKIM result), and more than `INBOUND_MAX_PER_SENDER_HOUR` messages an hour from one
  sender. Notices NovaDesk sends are marked `Auto-Submitted` too, so no auto-responder answers them: there is no loop.
- **The sender** is found by email address. Someone with no account becomes a *contact* (a user who cannot sign in until an
  administrator sets a password, or they sign in with single sign-on); `INBOUND_UNKNOWN_SENDERS=ignore` or
  `INBOUND_ALLOWED_DOMAINS` stops that. A switched-off account is refused.
- **A reply** is matched to its incident by the notice's Message-ID (`In-Reply-To`), or by the `[INC0000123]` in the
  subject, and becomes a public comment: only the new text, not the quoted notice below it. Only the incident's caller,
  its assignee, a watcher or staff can comment that way; anyone else who quotes a number gets an incident of their own. A reply
  to a resolved incident reopens it; a reply to a closed one opens a new incident.
- **Anything else** opens an incident: the subject as title, the text as description, priority P4, in
  `INBOUND_ASSIGNMENT_GROUP` if set. The sender is emailed the usual "incident logged" notice with the number.
- **Text only:** HTML mail is stored as plain text (no markup, scripts or remote images ever reach a page). Files are
  kept (up to 10, 10 MB each, never program files); small inline pictures such as signature logos are skipped. What
  was not kept is written in the incident's history.
- The list of handled messages is kept `INBOUND_LOG_DAYS` (90) days; the incidents stay.

A sender's address is only as trustworthy as the mail system in front of NovaDesk: anyone can write a false `From`. Turn on
SPF, DKIM and DMARC for the help desk's domain; `INBOUND_REQUIRE_AUTH=true` then accepts only mail the receiving server
vouches for. In a hostile setting, `INBOUND_UNKNOWN_SENDERS=ignore` (or an allowed-domains list) also keeps a spoofed address
from getting a contact and an acknowledgement. Not covered yet: service requests, changes and problems by email, OAuth sign-in
to the mailbox, and replies that add internal work notes.

Checked by `node scripts/inbound-check.js` (runs in CI against a real mail server, GreenMail): the mailbox and HTTP ways in,
replies and threading, nothing twice, machines and floods, files, settings, and the administrator's page.

## Importing data

Users, configuration items and knowledge articles can be brought in from a CSV file: the *Import CSV* button on the
Users, CMDB and Knowledge Base pages, or *Import data* in the administrator's menu. Users are for administrators;
configuration items and articles for administrators and agents.

1. **Choose the file** (up to 5 MB; 1,000 users or 5,000 other rows). Each kind has an *Example file* to start from, and a
   file exported from the CMDB or Knowledge Base page can be edited and imported again. Column names are matched without
   regard to capitals, spaces and punctuation; columns NovaDesk does not know are ignored. UTF-8, UTF-16 and Excel's
   Windows-1252 files are read, with commas, semicolons or tabs.
2. **Read the preview.** Every row is judged against what exists now and nothing is saved: what will be added, updated,
   or left alone, and, for each row that cannot be imported, why (a type that does not exist, a date that is not
   `YYYY-MM-DD`, an owner who is not an active user, the same user twice, an email that belongs to someone else ...).
3. **Confirm.** The rows that are fine are imported, the rest are skipped and listed (also as a file to correct and
   upload again). A file is confirmed once; running it again adds only what is still missing. The record of each import
   (who, which file, how many added, updated and refused) is kept for 90 days, and the audit log notes it, and every
   account it creates or changes.

*When something in the file already exists*, choose to leave it alone (only new things are added) or to update it: a
cell with something in it replaces what is there, an empty cell changes nothing. An item is found by its number
(`CI Number`, `Number`, `Username`) or, without one, by its name (and type) or title; a name that matches more than one
item is refused rather than guessed.

- **Users:** no password is needed. Someone added without one signs in with single sign-on, or an administrator sets a
  password on the Users page. A `Password` column is allowed for new users and must pass the password rules (a file with
  passwords in it should be deleted afterwards); it is never shown back and cannot change the password of someone who
  exists. An import cannot change your own role or active status, or leave NovaDesk without an active administrator, and
  switching a person off ends their sessions.
- **Configuration items:** types, environments and statuses can be written as the key or as the label (`network_device`
  or `Network Device`). The owner is a username, an email address or a full name that belongs to one person. CI-to-CI
  relationships are not imported.
- **Knowledge articles:** the body is plain text with line breaks kept (it is always shown as text, never as markup).
  New articles without a Status column are drafts unless you choose published.

Checked by `node scripts/import-check.js` (runs in CI): who may import what, forged and oversized uploads, the preview
that saves nothing, confirming once even when two requests race, the export-and-import-again round trip, odd files, and
the record kept.

## Privacy tools

*Privacy* in the administrator's menu (and *Open privacy tools* on each user's page). Administrators only; every action is
in the audit log.

- **What is held about a person, and a file of it.** Search for a person, see how many records of each kind mention them,
  and download everything as JSON: their details, sign-in methods (no secrets), their own words (incidents they
  reported, comments, articles, request notes), the facts of what they did (tickets assigned to them, approvals, items
  they own, files they uploaded), notices sent to them, mail they sent in, and the audit log both ways. Never password
  hashes, two-step secrets or API key hashes, and not what other people wrote on the same records.
- **Anonymise a person** (cannot be undone). The account stays, so every ticket, comment and log entry still points at
  someone and keeps its time, but it no longer says who they were: name, username, email and department go; so do the
  password, single sign-on links, two-step verification, API keys, open sessions, group memberships and followed
  records; their name, username and email are replaced by "Anonymised user N" (or "[email removed]") in notices, the
  activity and audit logs, inbound mail records, webhook copies, import records and decommission cards, and the
  addresses they came from are cleared from the audit log. Optionally the text of their comments is replaced and the
  files they uploaded are deleted. It is all done in one database transaction: a failure leaves everything as it was.
  Ticket text itself (titles, descriptions, other people's comments) is not searched or rewritten, names or usernames
  shorter than 4 characters are not searched for in text (the page says so), and server backups, the mail server and
  other connected systems still hold what they held. Not possible for yourself. An anonymised account cannot be
  edited, signed in to, or brought back by a CSV import.
- **Retention.** Each of the audit log, email notices, the inbound email record and webhook deliveries is kept for ever
  until you set a number of days (30 at least). Once a day older rows are removed in batches (unfinished work is never
  touched: mail still being processed, deliveries still waiting); *Run now* does it at once. Tickets, comments and their
  history are never removed. Shortening the audit log's limit shortens what can be investigated later: many security
  standards ask for a year or more.

Checked by `node scripts/privacy-check.js` (runs in CI): who may use it, the contents of the file and everything it leaves
out, what anonymising removes and keeps (including look-alike names and addresses), that a failure half-way changes
nothing, the extras, and retention with the daily sweep, "Run now", batches and work in progress left alone.

## SCIM provisioning

Lets an identity provider (Okta, Microsoft Entra ID, or anything that speaks SCIM 2.0, RFC 7643 and 7644) create, change
and switch off people in NovaDesk, so nobody has to be added or removed by hand. *SCIM provisioning* in the
administrator's menu. People it creates sign in with single sign-on (OpenID Connect, described under Settings) (it never sets a
password); an existing person is found by their email address the first time, as with any single sign-on.

**Connect a provider**

1. Set `PUBLIC_URL` (the address people reach NovaDesk at) and set up single sign-on.
2. *SCIM provisioning* > *Make token*, one per provider. The token (`nds_...`) is shown once; only a hash is kept. It can
   provision people and nothing else (it cannot read or change tickets), expires when you say, and is revoked at once.
3. In the provider: base URL `https://your-novadesk/scim/v2`, authentication *HTTP header / Bearer token* with the token,
   and `userName` as the unique identifier (the email address works well). Map `userName`, `emails` (work, primary),
   `name` or `displayName`, `active`, optionally `externalId`, `roles` (admin, agent or user) and the enterprise
   `department`. Okta: *Provisioning > Integration > SCIM*; Entra ID: *Enterprise application > Provisioning > Admin
   credentials* ("Secret Token").

**What it does**

| Request | What NovaDesk does |
| --- | --- |
| `GET /Users?filter=...` | `eq ne co sw ew pr`, `and or not` and brackets on `userName`, `externalId`, `id`, `active`, `emails.value`, `displayName`; `startIndex`, `count` (100 at most); `attributes`, `excludedAttributes` |
| `POST /Users` | creates the person (201). A `userName` or email another account already has is a 409. A pushed `password` is ignored. The role is the provider's `roles`, else the default you choose (user or agent) |
| `PUT` / `PATCH /Users/{id}` | changes name, email, department, role, `externalId`, `userName`, `active`. PATCH understands Okta's and Entra's shapes (capitalised operations, `"False"` as text, `emails[type eq "work"].value`, no-path objects). Attributes NovaDesk keeps nothing for (title, phone numbers ...) are accepted and ignored. PUT clears what it leaves out, except the role and whether the account is on |
| `active: false` | switches the person off: their sessions end and their API keys are revoked at once. Switching on again restores nothing else |
| `DELETE /Users/{id}` | removes a person who has no history; a person with tickets or comments is switched off instead (their history stays whole) |
| `GET /Groups`, `PATCH` / `PUT /Groups/{id}` | NovaDesk's eight assignment groups. They cannot be created, renamed or deleted; members can be added and removed once an administrator allows it (members of IRO-Build/Decom can approve decommissions) |
| `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | say what is supported: patch and filters yes; bulk, sort, etag and password change no |

**What it may not do** (the choices are on the page, and each is off until you turn it on)

- *Make or change an administrator.* Without it, SCIM cannot create an administrator or change an administrator's role
  (it can still switch an administrator off, for someone who leaves).
- *Change group membership.*
- However they are set, SCIM can never switch off, demote or delete the **only active administrator**, and it cannot
  see or change a person who was anonymised.
- An email address belongs to one account only (single sign-on finds people by it), and a `userName` is unique whatever
  its capitals.

Every action is in the audit log under the token's name (`SCIM: Okta`), with what changed (the fields, not their
values). Limits: `RATE_LIMIT_SCIM_PER_MIN` per token (default 600), and 30 wrong tokens from one address per 15 minutes
slow that address down (a right token still works). A person made or changed by SCIM is marked *SCIM* on the Users
page: edits made by hand there may be overwritten at the provider's next sync.

Checked by `node scripts/scim-check.js` (runs in CI, against the mock identity provider): tokens and who may make them,
the lifecycle the way Okta and Entra drive it, every refusal, the administrator and anonymised-person protections,
groups, single sign-on of a provisioned person (and its refusal when switched off), the audit log, and rate limits.

## Custom fields

*Custom fields* in the administrator's menu. Add the fields your organisation wants to record that NovaDesk does not ask
for out of the box, to **incidents, service requests, changes, problems and configuration items**: a cost centre on an
incident, a support contract on a CI, a change window on a change.

- **Kinds of value:** text (one line, 255 characters), text (several lines, 4,000), number, date, choice from a list (up
  to 50 choices, one per line, or `value|Label`) and yes/no. Each field has a **label**, optional **help text** shown under
  it, and a **key** (made from the label unless you give one) that is used in the API. The key and the kind of value can
  never change once the field exists; everything else can. Up to 30 fields for each kind of record.
- **Required:** the form (and the API, when creating) will not accept the record without a value; a required yes/no has to
  be ticked. Records made by something that is not a form (inbound email, the decommission automation) are not held up:
  they are made without a value, and the next person to save the record in a page is asked for it.
- **Who sees it:** everyone who can see the record, or agents and administrators only (an end user never sees a staff-only
  field on the form, the page, the API or anywhere else, and cannot set it).
- **Switch off** hides a field everywhere (forms, pages, API, exports) and keeps its values; switching it on brings them
  back. **Delete** removes the field and every value it holds, and says how many. A choice that records use cannot be
  removed from a list (rename it instead).
- **Where they appear:** on the new-record and edit forms; as details on the record's page (for end users who may see
  the record, read-only); in the history of the record ("Cost centre changed from ... to ..."), and as extra columns at
  the end of each list's CSV export.
- **API:** every incident, request, change, problem and CI carries `custom_fields` (`{ "key": value }`, numbers as numbers,
  yes/no as booleans, a choice as its value, an unset field as `null`, only the fields the key's owner may see).
  Incidents, requests and CIs also accept `custom_fields` when created and changed (a key you leave out is left alone, `null`
  clears it, a choice can be given by its label); changes and problems are read-only in the API. See `/api/docs`.
- **Webhooks:** every event for these records carries `custom_fields` in the record, with every active field (a receiver is an
  integration an administrator set up, so staff-only fields are included), as they stand when the event is sent.
- **Not (yet) covered:** CSV import, search and list filters do not use custom fields. Knowledge articles and people have none.

Everything is audited (`customfield.created`, `.updated`, `.moved`, `.deleted`). Values live in their own table, never as
a column on a record table, so adding a field changes no table; a database trigger removes a record's values when the
record is deleted, whichever way it is deleted.

Checked by `node scripts/custom-fields-check.js` (runs in CI): who may define fields and every refusal, the fields on all five
kinds of record as an administrator, an agent and an end user, required, staff-only and switched-off fields, the history,
the API (read and write, typed values, every error), the OpenAPI document, the exports, and deleting.

## Branding

*Branding* in the administrator's menu. Show your own name, logo and colour instead of NovaDesk's, so the product can be
presented under another name. Everything left empty keeps the built-in look, and an install that never opens the page looks
exactly as before.

- **Name** (1 to 40 characters): the navigation bar, both sign-in pages, the browser tab, the API guide, help text on the
  pages, outgoing email, the "from" name of the sandbox mailbox, and the label in an authenticator app for people who set up
  two-step verification from then on (authenticator entries made earlier keep their old label).
- **Logo:** PNG, JPEG, GIF or WebP up to 512 KB, recognised from its first bytes (a wrong file name or type does not matter).
  **SVG is refused** because an SVG can carry script and the logo is served from the application's own address. It is shown
  on a light tile so a dark logo stays visible on the dark navigation bar; it is also the browser-tab icon and, when
  `PUBLIC_URL` is set, sits at the top of emails (a mail program needs a full address to fetch it from).
- **Accent colour** (`#rrggbb`): everything is worked out from this one colour, in both the light and the dark theme:
  links, buttons, the navigation bar, pagination, ticked boxes, focus rings, and the sign-in page. A colour that white text
  cannot be read on (contrast below 4.5) is refused with the reason; for the dark theme the colour is lightened until it
  reads on the dark page, and the sign-in button's shades are chosen so its dark text reads on both ends.
- **Sign-in pages:** the line above and below the name, and what is behind the card: the **built-in picture** (it shows
  NovaDesk's own artwork, so choose another when the product is shown under your name), a **plain backdrop** in your colour,
  or **your own picture** (up to 2 MB; choosing a file switches it on; switching away keeps it stored).
- **Email:** every notice is framed the same way: the name (and logo) in the accent colour, the message, and a closing line
  you can write (default "Sent by <name>."). The sender address is still `SMTP_FROM`. The copy kept for Preview on the
  Notifications page is the framed one; earlier notices are not rewritten.
- **Not changed:** the names integrations rely on stay as they are: the `X-NovaDesk-*` webhook headers and the
  `NovaDesk-Webhooks` user agent, and the SCIM and OpenAPI descriptions. Messages between NovaDesk and NovaConnect (the
  decommission cards) are internal and keep the name too.

Settings live in one table (`branding_settings`), pictures included, so a database backup is a backup of the branding. Every
change and a reset is audited (`branding.changed`, `branding.reset`; the picture itself is never written to the log). The logo
and the sign-in picture are public (the sign-in page shows them) at `/branding/logo` and `/branding/background`, served with
`Content-Security-Policy: sandbox` so even a file opened directly cannot run anything, cached by the browser for an hour and
fetched afresh when the picture changes (the address carries a version). Changes show at once on the server that saved them
and within five seconds on another copy behind the same database.

Checked by `node scripts/branding-check.js` (runs in CI): who may change it, the name, wording, colour and pictures on every
kind of page, every refusal (empty or long text, a colour too light to read, markup in a name, an SVG or a disguised file as
a logo or background, a picture over its limit), the address the pictures are served from, the email frame, the
authenticator label, the audit log, and putting everything back.

## Several organisations on one installation (tenants)

One NovaDesk and one database can serve several organisations that must not see each other: an IT provider with
customers, or a product sold as a service. Everything that exists on an installation today is the **default tenant**, and
nothing changes for a single organisation.

- **What is separate:** everything an organisation owns: people, sessions, incidents, requests, changes, problems,
  configuration items, knowledge articles, comments, files, notifications, the audit log, API keys, SCIM tokens, webhooks,
  custom fields, SLA targets and calendar, branding, retention limits and ticket numbers (each tenant's first incident is
  INC0000001). The same username can exist in two tenants as two different people.
- **How it is kept apart:** by the database, not only by the pages. Each table has a `tenant_id` and a row level security policy
  (migration 0015); the application connects as the restricted role `novadesk_app` (it switches to it on every connection, even
  when the login role is a superuser), and every statement names the tenant of the request. A query that forgets to filter still
  sees only its own tenant's rows, and a write naming another tenant is refused. A database call made outside any tenant fails
  instead of guessing. The few places that look across tenants (finding which tenant an API key belongs to, the background
  jobs, expired-session clean-up) say so explicitly in `src/tenancy.js`.
- **Which tenant a request is for:** the host name in the address bar: a name listed for a tenant (`tenant_hosts`), else
  `<short name>.TENANT_BASE_DOMAIN`. Any other host is the default tenant's (`TENANT_UNKNOWN_HOST=default`) or refused with a 404
  (`reject`, the setting for an installation that serves several organisations). An API key or SCIM token belongs to a tenant
  itself and needs no host name. A session cookie made for one tenant is nothing at another's address.
- **Suspending:** a suspended tenant's pages answer 503 and its API keys and SCIM tokens are refused (403); its data is kept.
  A running server learns of a new or suspended tenant within five seconds. The default tenant cannot be suspended.
- **Background work** (webhook delivery, SLA warnings and breaches, retention, the decommission jobs) runs for each tenant in
  turn; one tenant failing never stops the rest.
- **What is still one for the whole installation:** the mail server (`SMTP_*`), the inbound mailbox and HTTP mail intake (`INBOUND_*`), and the NovaConnect/ESXi decommission
  integration. Those belong to the **default tenant**; other tenants sign in with passwords, SCIM or their own single sign-on. Moving mail and the inbound mailbox into each
  tenant's own settings is the next step. Making and suspending tenants is done in the platform console (next).
- **Single sign-on for each tenant:** *Single sign-on* in the administrator's menu. A tenant sets up its own provider (OpenID Connect:
  Microsoft Entra ID, Google, Okta and others): issuer address, client ID and secret (kept encrypted, never shown again), button
  text, scopes, whether to make an account on first sign-in (never an administrator), which email domains may sign in, and whether
  to trust an email the provider has not marked verified. The page shows the **redirect address** to register with the provider: it is
  the tenant's own host name, so each tenant registers its own. **Test the connection** reads the provider's configuration without signing
  anyone in. People are linked to the provider per tenant, so the same person at the same provider is a separate account in each
  tenant. The server's own `OIDC_*` settings still serve the **default tenant** when it has none of its own, so an installation that set
  them carries on as before. `LOCAL_LOGIN=false` now hides the password form only for a tenant that has single sign-on to use instead.
  Because the tenant's administrator chooses the provider's address, **the server refuses addresses that lead to private, local or
  reserved networks** (and anything that is not https) when it is saved and again each time it is used; `SSO_ALLOW_PRIVATE=true`
  lifts that for a lab. (The check resolves the name when it is made, so it does not stop a name that is changed to an internal address
  between the check and the fetch.) Checked by `node scripts/tenant-sso-check.js` (in CI) against the mock provider.
- **The platform console:** set `PLATFORM_HOST` (for example `ops.helpdesk.example.com`) and that host name shows a console of its
  own, for the people who run the installation (the *operators*, who belong to no tenant): the tenants with counts of their
  people and records (never their content), **making a tenant** (name, short name, host names and its first administrator),
  renaming, adding and removing host names, **suspending and reactivating**, and **a new password for a locked-out tenant
  administrator** (it ends that person's sessions and is written in the tenant's own audit log as done by the platform).
  Everything an operator does is in the platform's audit log. Without `PLATFORM_HOST` the console does not exist, not even
  at that name. The first operator comes from `PLATFORM_ADMIN_USERNAME` and `PLATFORM_ADMIN_PASSWORD` (made once, when there
  is none). `PLATFORM_ALLOWED_IPS` limits who may reach it (others get a plain 404). Sign-in is a password with a lock-out after five
  wrong ones; the session is a signed cookie (HttpOnly, SameSite=Strict, two hours) and forms carry a page token. **There is no
  two-step verification for operators yet**, so keep the console behind a VPN or the address list. Checked by
  `node scripts/platform-check.js` (in CI).
- **Honest limits:** the policies protect against a query that is missing a filter, not against someone who can run their own SQL
  as the application (the tenant is a session setting). Files attached to records are stored on disk under random names and are
  reached only through their record, which is tenant-checked. A reference to another tenant's row (a person's id typed into a
  form by hand) is possible as a bare number, but nothing of that row is ever shown.

Checked by `test/tenancy.db.test.js` (at the database, as the restricted role: every table is protected, rows are invisible and
unwritable across tenants, names are unique per tenant, platform mode, the guard that fails when a new table is not under the
rules) and `node scripts/tenancy-check.js` (runs in CI, through the whole application, with two more tenants and two servers):
sign-in and sessions, every kind of record by its id, writes aimed at another tenant, ticket numbers, API keys, SCIM, webhooks,
settings, suspension and host names.

## Security

- **Forged requests (CSRF):** every form and every in-page request carries a per-session token, and a page change
  made without it is refused with "Please reload the page". The REST API is not affected: it uses keys, not cookies.
- **Passwords:** at least `PASSWORD_MIN_LENGTH` characters (default 10), not a common password, not containing the
  person's own name or user name. Administrators must give a password when they create a user (there is no default).
- **Lockout:** `LOCKOUT_AFTER` wrong passwords in a row lock the account for `LOCKOUT_MINUTES`; an administrator can
  unlock it from the user's page. The sign-in page also limits failed attempts per address (`RATE_LIMIT_LOGIN_FAILURES`).
- **Audit log:** administrators see who signed in, failed to, changed a user, a password, an API key, a webhook or the
  SLA settings under Settings, Audit log, and can export it as CSV. Typed passwords and unknown user names are never stored.
- **Cookies and headers:** the session cookie is `Secure` automatically when the request arrived over https (set
  `TRUST_PROXY` behind a proxy); the pages send `Permissions-Policy`, `Cross-Origin-Opener-Policy` and the other
  usual hardening headers.
- **Sessions:** sign-ins are rows in the database (not files), so a restart signs nobody out, and each person can see
  where they are signed in (user menu, *Where I am signed in*: device, address, when) and end any of them or all the
  others. Changing your own password signs you out everywhere else; an administrator setting a new password, resetting
  two-step verification or switching an account off ends that person's sessions, and *Users*, the person, *Sign out
  everywhere* does it on demand. Sessions last 8 hours (30 days with *Remember me*); expired ones are cleared every
  ten minutes.
- **Content-Security-Policy:** the browser runs only scripts NovaDesk sent: each page carries a fresh random nonce,
  inline event handlers and `javascript:` links are not allowed, and external scripts may come only from this server
  and the Bootstrap, Chart.js and Sortable CDNs. Text that reaches a page by mistake (a ticket description with
  `<script>` in it) therefore cannot run, even if some future page forgot to escape it. Pages say what they want with
  data attributes (`data-confirm`, `data-href`, `data-no-row`) handled by `public/js/app.js`; `npm test` fails on a view
  with an inline handler or a script without `nonce="<%= cspNonce %>"`. Blocked attempts are written to the server
  log as `[CSP] ...`. `CSP_MODE=report` only reports (to try a change), `CSP_MODE=off` removes the header.
- **Last administrator:** the only active administrator cannot be demoted, deactivated or deleted.

Checked by `node scripts/security-check.js` (runs in CI): forged posts and uploads, headers, password rules,
lockout and unlock, the last-administrator guard and the audit log.

## Notes

- End users (`role: user`) only see and create their own incidents/changes, and cannot edit CMDB or see internal work notes.
- Agents and admins can manage tickets, changes, and CMDB records; only admins can manage users or delete CMDB items.
- This is a self-contained local app — reset by deleting the `data/` folder.

## Checking that pages, routes and the NovaConnect integration agree

```bash
node scripts/contract-check.js          # forms, links, fetch() and redirects reach a route; every view variable is passed
NOVACONNECT_REPO=../NovaConnect node scripts/contract-check.js   # also the NovaDesk <-> NovaConnect integration calls
node --test test/*.test.js
```

It is static analysis (no server or database) and needs `acorn`, taken from a sibling NovaConnect checkout or `npm install --no-save acorn@8.18.0`. Run it before a release; a failure is a page or an integration call that would break.

```bash
BASE_URL=http://127.0.0.1:18080 node scripts/walkthrough.js     # drives every module through its real pages and forms (76 steps)
```

`scripts/walkthrough.js` needs a running instance started with `SEED_DEMO=true` on an empty database (the demo users) and creates records on it: use a throwaway one, never production. Its last step fires wrong passwords until the sign-in limiter answers 429 (`WALK_SKIP_BRUTE_FORCE=1` skips it).

CI (`.github/workflows/ci.yml`) runs all of this on every push, and also: a clean start (first admin, no demo data, strict production settings), a fresh install with `compose.yaml` (data survives a container recreate and the backup/restore above, then the walk-through), and two in-place upgrades (from the release before the latest, and from 0.0.35) checked with `scripts/upgrade-check.js`. A change to the schema code in `src/db.js` has to keep the upgrade jobs green: additive and idempotent, with defaults for existing rows.
