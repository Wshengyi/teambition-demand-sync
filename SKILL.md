---
name: teambition-demand-sync
description: Mirror a Teambition project view into MySQL over a logged-in Chrome CDP session, so tasks (title, status, custom fields) and change history become queryable with plain SQL. Use when the user wants to sync, dedupe, or report on a Teambition demand/task view.
version: 0.1.0
---

# teambition-demand-sync

This skill runs the `tb_sync.js` script bundled in this repository. It
reads a Teambition view via a Chrome DevTools Protocol tab already logged
into the Teambition instance, then writes tasks into MySQL and records
per-field diffs.

## When to use

Trigger this skill when the user wants to:

- Sync a Teambition project view into MySQL for querying.
- Track field-level changes over time (`demand_change_log`).
- Schedule hourly / periodic Teambition → SQL mirroring.
- Investigate why a recent Teambition edit did not show up in MySQL (see
  the config's `customFields` mapping and the `demand_change_log` table).

## How to use

1. **Install deps once**:

   ```bash
   npm install
   mysql -u <user> <db> < schema/demand.sql
   ```

2. **Copy and edit the config**:

   ```bash
   cp config/tb_sync.example.json config/tb_sync.config.json
   ```

   Fill in:
   - `teambition.host` (e.g. `www.teambition.com` or a self-hosted host)
   - `teambition.projectId` / `teambition.viewId` (from the view URL)
   - `teambition.customFields` — map friendly column names to
     Teambition custom field ids (the column names must exist in the
     `demand` table).
   - `cdp.port` — the Chrome remote debugging port you already run with.
   - `database.*` — MySQL connection details.

3. **Make sure Chrome is logged into Teambition** and listening on the
   CDP port:

   ```bash
   open -na "Google Chrome" --args \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.config/tb-sync-chrome"
   ```

   Then log into Teambition in that Chrome window once.

4. **Run**:

   ```bash
   node scripts/tb_sync.js --config config/tb_sync.config.json
   ```

   Or wrap it via `scripts/run_tb_sync.sh` and schedule with cron /
   launchd / OpenClaw cron.

## What it does

- Opens the configured Teambition view via CDP and calls
  `/api/v2/projects/<projectId>/tasks?filter=...` from the page context
  (so it inherits the logged-in session).
- Upserts each task into the `demand` table, using `tb_task_id` as the
  natural key.
- For existing rows, compares `task_status` and every custom-field
  column against DB state. Any change writes a row to
  `demand_change_log` and updates the `demand` row.
- Every run writes a summary row into `demand_sync_log`.

## Debugging tips

- **"No usable Chrome CDP page target"** — Chrome is not running with
  the CDP port open, or `cdp.port` in config is wrong.
- **`fetched=0`** — the CDP tab exists but is probably logged out. Open
  the Teambition URL manually in that Chrome to re-auth, then re-run.
- **A field change did not sync** — check that the field is mapped in
  `teambition.customFields` and that the `demand` table has a matching
  column. `demand_change_log` shows every change the script actually
  detected.
