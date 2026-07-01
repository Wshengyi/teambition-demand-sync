# teambition-demand-sync

[English](./README.md) · **简体中文**

把 **Teambition 项目视图** 同步到 **MySQL 需求池**，让 Teambition 的任务
（标题、状态、自定义字段、变更历史）都能用 SQL 查询和统计，不用再花钱开
Teambition 的数据导出功能。

- 从你指定的 **固定 Teambition 视图** 拉任务
- 用 **已登录的 Chrome CDP 会话** 作为传输通道（不用 OAuth、不用申请
  企业机器人 token）
- 写入 MySQL 三张表：`demand` / `demand_change_log` / `demand_sync_log`
- **真正的字段级 diff**：状态或任何映射到自定义字段的列一变就写日志
- 幂等，可以放心用 `cron` / `launchd` / OpenClaw cron 每小时跑

## 环境要求

- Node.js 18+
- MySQL 5.7 / 8.x
- 一份已经登录 Teambition 的 Chrome（或 Chromium），并且带
  `--remote-debugging-port` 参数开启了 CDP
- 你知道你要同步的 Teambition **项目 ID**、**视图 ID**，以及要镜像的
  **自定义字段 ID**

## 安装

```bash
git clone https://github.com/<your-account>/teambition-demand-sync.git
cd teambition-demand-sync
npm install
mysql -u root your_db < schema/demand.sql
cp config/tb_sync.example.json config/tb_sync.config.json
$EDITOR config/tb_sync.config.json
```

## 怎么找那些 ID

浏览器里打开你想同步的 Teambition 视图，URL 长这样：

```
https://<host>/project/<projectId>/tasks/view/<viewId>
```

`projectId` 和 `viewId` 直接从 URL 里取。

**自定义字段 ID**：打开 DevTools → Network，筛选 `customfields`，
在 Teambition 界面点开任意一条任务，返回体里 `_customfieldId` 就是。

默认示例配置里预置了四个字段位：`customer_contact`、`menu`、
`demand_type`、`priority`。你想用什么字段就改什么字段——脚本会读取
你在 `teambition.customFields` 里定义的所有 key，并且期望 `demand`
表里有对应的列。

## 运行

先确保 Chrome 开着 CDP 并且已经登录 Teambition，例如：

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/tb-sync-chrome"
```

然后：

```bash
node scripts/tb_sync.js --config config/tb_sync.config.json
# 或者用封装好的
TB_SYNC_CONFIG=config/tb_sync.config.json ./scripts/run_tb_sync.sh
```

再用 `cron` / `launchd` / 任何调度器把它挂成每小时跑一次就好。

## 配置说明

见 [`config/tb_sync.example.json`](config/tb_sync.example.json)。几个
关键开关：

- `teambition.filter` —— 覆写默认的"当天有更新的任务"过滤器，可以填
  任何合法的 Teambition filter DSL 字符串。
- `teambition.pageSize` —— 每页拉多少条（最大 200）。
- `teambition.customFields` —— **核心映射**：把 `demand` 表里你要
  写的列名（key）映射到 Teambition 的自定义字段 ID（value）。
- `cdp.autoLaunchChrome` —— 如果为 `true` 而且指定端口上没 Chrome
  在监听，脚本会尝试用 `chromeBinary` + `userDataDir` 拉起一个新的
  Chrome。
- `database.tables` —— 三张表可以换名字。

## 表结构

见 [`schema/demand.sql`](schema/demand.sql)。同步过程中脚本只会更新
`task_status`、`customFields` 里映射的列，以及三个记账列
（`merchant_count`、`tb_last_updated_at`、`last_synced_at`）。

## 常见坑

- **"No usable Chrome CDP page target"**：Chrome 没开 CDP 端口，或者
  配置里的 `cdp.port` 写错了。
- **`fetched=0`**：CDP 页签在，但很可能已经掉登录了。手动在那个
  Chrome 里访问 Teambition URL 重新登录一下，再跑一次。
- **某个字段改了没同步过来**：
  1. 确认 `teambition.customFields` 里把它映射了；
  2. 确认 `demand` 表里有对应列名；
  3. 看 `demand_change_log` —— 脚本"真正识别到的变化"都会写进去，
     没写就是脚本这一层就没识别到。

## 关于最初那个 bug

这个仓库最早的动机就是老版 `tb_sync.js` 里一个坑：`menu` 和
`demand_type` 只有在"旧值为空、新值非空"才会触发 update。也就是说
你在 Teambition 里把某个任务从"订单"改成"打印"，同步会静默跳过，
只有从"空"改成"某个模块"才会写库。本仓库版本改成了通用的字段级
diff，任何变化都会触发 update 并按字段写变更日志。

## 许可协议

MIT