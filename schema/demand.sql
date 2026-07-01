-- Teambition Demand Sync — MySQL schema
-- Compatible with MySQL 5.7+ / 8.x. Charset utf8mb4.

CREATE TABLE IF NOT EXISTS `demand` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `tb_task_id` VARCHAR(50) DEFAULT NULL,
  `title` VARCHAR(500) NOT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `tb_last_updated_at` DATETIME DEFAULT NULL,
  `last_synced_at` DATETIME DEFAULT NULL,
  `task_status` VARCHAR(50) DEFAULT NULL,

  -- The next columns match the "customFields" keys in tb_sync.config.json.
  -- Add or remove columns to match your own custom fields, then update the
  -- corresponding customFields mapping in the config file.
  `customer_contact` TEXT,
  `merchant_count` INT NOT NULL DEFAULT 0,
  `menu` VARCHAR(200) DEFAULT NULL,
  `demand_type` VARCHAR(100) DEFAULT NULL,
  `priority` VARCHAR(50) DEFAULT NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tb_task_id` (`tb_task_id`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_menu` (`menu`),
  KEY `idx_task_status` (`task_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `demand_change_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `demand_id` INT DEFAULT NULL,
  `tb_task_id` VARCHAR(50) DEFAULT NULL,
  `title` VARCHAR(500) DEFAULT NULL,
  `field_name` VARCHAR(100) NOT NULL,
  `old_value` TEXT,
  `new_value` TEXT,
  `source` VARCHAR(50) DEFAULT 'tb_sync',
  `changed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_demand_id` (`demand_id`),
  KEY `idx_tb_task_id` (`tb_task_id`),
  KEY `idx_field_name` (`field_name`),
  KEY `idx_changed_at` (`changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `demand_sync_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `source_view_id` VARCHAR(50) DEFAULT NULL,
  `fetched_count` INT DEFAULT 0,
  `inserted_count` INT DEFAULT 0,
  `updated_count` INT DEFAULT 0,
  `error_count` INT DEFAULT 0,
  `status` VARCHAR(20) DEFAULT NULL,
  `remark` TEXT,
  `run_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_run_at` (`run_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
