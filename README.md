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
*Two-step verification*, add the key to an authenticator app (Microsoft Authenticator, Google Authenticator,
Authy, 1Password), confirm with a code, and keep the ten recovery codes shown once. The password then leads to a
code page. Each code works once; five wrong codes lock the code step for that person for ten minutes; a recovery code
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

**Upgrading:** `git pull`, then `docker compose up -d --build --force-recreate novadesk` (or
`podman compose …` with the same options). `--force-recreate` matters on Podman: podman-compose
rebuilds the image but leaves the running container on the old one without it. The database and the
data volume keep their contents; table changes are numbered migrations (`src/migrations/`) that NovaDesk
applies itself when it starts, once each, all or nothing. `docker compose exec novadesk node src/migrate.js
status` lists them. Back up first (below).

**Backups.** Two things hold your data: the database and the data volume (attachments, sessions and
the Decommissioned Tracker workbook). Use your own database user in place of `novadesk` if you changed `PGUSER`.

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
docker compose exec -T postgres pg_restore -U novadesk -d novadesk --no-owner --exit-on-error < novadesk.dump
docker compose run --rm --no-deps -T --entrypoint tar novadesk -C /app/data -xf - < appdata.tar
docker compose up -d novadesk
```

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
