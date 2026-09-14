# NovaDesk ITSM

A ServiceNow-style IT Service Management app: Incident Management, Change Management, and a CMDB (server/asset inventory) — with role-based access (admin / agent / end user).

## Stack

- Node.js + Express, EJS server-rendered views, Bootstrap 5
- SQLite via Node's built-in `node:sqlite` module (no native build required) — requires **Node.js 22.5+** (24.x recommended)
- Session auth with bcrypt-hashed passwords, file-based session store

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000. The database (`data/itsm.db`) is created and seeded automatically on first run with demo users, CMDB assets, incidents, and change requests.

## Demo logins

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
