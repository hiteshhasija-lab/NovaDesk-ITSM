# Database migrations

The database structure is built by the numbered SQL files in this folder. NovaDesk applies the ones it has
not applied yet when it starts, in order, each once, and records them in the table `schema_migrations`.

```bash
docker compose exec novadesk node src/migrate.js status    # applied / waiting
docker compose exec novadesk node src/migrate.js up        # apply what is waiting (start-up does this too)
```

## Changing the structure

1. Add a file `NNNN_what_it_does.sql` with the next number: `0002_add_sla_policy.sql`. Four or more digits, an
   underscore, lower-case words and underscores.
2. Write plain SQL. Everything waiting runs in one transaction: either all of it is applied or none of it.
3. Make it additive wherever you can (new table, new column that allows NULL or has a default). An older release
   started on the same database after a rollback keeps working only when nothing it uses was removed or renamed.
   Remove or rename in two steps: one release stops using it, a later release drops it.
4. Run `node --test test/` (the database tests run when `PGHOST` points at a scratch Postgres).

## Tables that hold an organisation's data

NovaDesk serves several organisations (tenants) from one database (migration 0015). A new table that holds an
organisation's data must be put under the same rules, right after it is created:

```sql
CREATE TABLE widgets (id SERIAL PRIMARY KEY, label TEXT NOT NULL);
SELECT nd_tenant_scope('widgets');   -- adds tenant_id (defaulting to the statement's tenant), an index and row level security
```

Make a name that must be unique unique *within a tenant*: `UNIQUE (tenant_id, label)`, and name the columns in
`ON CONFLICT (tenant_id, label)`. `test/tenancy.db.test.js` fails, naming the table, if one is missing. A table that really
is shared (a list of tenants, say) is the exception and is named in that test.

## Rules

- **Never edit a file that has been released.** Its checksum is stored; an edited file stops NovaDesk from starting
  and names the file. Put the change in a new file.
- **Never renumber.** If two branches both add `0003`, the second to merge takes the next free number.
- `0001_baseline.sql` is the schema as it was when migrations began. It only uses `IF NOT EXISTS`, so it runs on a
  new database and on an install from any earlier release without changing existing data.
- Seed data (the first admin, the demo workspace) is not a migration; it lives in `src/db.js`.
- Statements Postgres refuses inside a transaction (such as `CREATE INDEX CONCURRENTLY`) are not supported.
- In SQL, a `?` is read as a placeholder by the database layer only when bindings are passed; migrations pass none,
  so JSONB operators like `?` are safe.
