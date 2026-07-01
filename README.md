# teambition-demand-sync

**English** · [简体中文](./README.zh-CN.md)

A hourly-friendly sync that mirrors a **Teambition project view** into a
**MySQL "demand pool"**, so you can query, aggregate, and report on tasks
with plain SQL — without paying for Teambition's data export tier.

- Pulls tasks from a **fixed Teambition view** you specify
- Uses a **logged-in Chrome CDP session** as the transport (no OAuth app
  or bot token required)
- Writes rows into MySQL: `demand`, `demand_change_log`, `demand_sync_log`
- **Detects real field changes** and writes them into `demand_change_log`
  (title, task status, and every custom field you mapped)
- Idempotent — you can safely run it every hour from `cron` / `launchd` /
  a scheduler like OpenClaw

## Requirements

- Node.js 18+
- MySQL 5.7 / 8.x
- Google Chrome (or any Chromium) running with `--remote-debugging-port`,
  logged into the Teambition instance you want to sync
- You know your Teambition **project id**, **view id**, and the **custom
  field ids** you want to mirror

## Install

```bash
git clone https://github.com/<your-account>/teambition-demand-sync.git
cd teambition-demand-sync
npm install
mysql -u root your_db < schema/demand.sql
cp config/tb_sync.example.json config/tb_sync.config.json
$EDITOR config/tb_sync.config.json
```

## Getting your ids

Open your Teambition view in Chrome — the URL looks like:

```
https://<host>/project/<projectId>/tasks/view/<viewId>
```

To find custom field ids, open DevTools → Network → filter `customfields`
while opening a task; the response contains `_customfieldId` values.

The example config ships with the four field slots this sync knows about:
`customer_contact`, `menu`, `demand_type`, `priority`. Rename or add
columns as needed — the script reads whatever keys you define under
`teambition.customFields`, and expects matching columns in the `demand`
table.

## Running

Ensure Chrome is running with debugging exposed and logged into
Teambition, for example:

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/tb-sync-chrome"
```

Then run:

```bash
node scripts/tb_sync.js --config config/tb_sync.config.json
# or
TB_SYNC_CONFIG=config/tb_sync.config.json ./scripts/run_tb_sync.sh
```

Schedule it hourly with `cron`, `launchd`, or your scheduler of choice.

## Configuration

See [`config/tb_sync.example.json`](config/tb_sync.example.json). Notable
knobs:

- `teambition.filter` — override the default "tasks updated today" filter
  with any Teambition filter DSL string.
- `teambition.pageSize` — how many tasks to fetch per page (max 200).
- `teambition.customFields` — map friendly column names (matching your
  `demand` table columns) to Teambition custom field ids.
- `cdp.autoLaunchChrome` — if `true` and no Chrome is listening on the
  configured CDP port, the script will attempt to spawn Chrome with the
  provided `chromeBinary` and `userDataDir`.
- `database.tables` — override table names if you cannot use the defaults.

## Schema

See [`schema/demand.sql`](schema/demand.sql). The script updates only the
columns that map to `task_status` and the keys under `customFields`, plus
the bookkeeping columns (`merchant_count`, `tb_last_updated_at`,
`last_synced_at`).

## Notes / caveats

- The script currently expects the Chrome tab to already have a valid
  Teambition session cookie. If it isn't logged in, `fetch` will return
  an auth challenge and the script will log 0 tasks.
- If a task changes back and forth quickly you'll get a row per real
  change in `demand_change_log`.
- Delete detection is out of scope — the script does not remove rows for
  tasks that disappear from the view.

## License

MIT