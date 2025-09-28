CREATE TABLE IF NOT EXISTS entity_profiles (
    entity_id TEXT PRIMARY KEY,
    nickname TEXT,
    room TEXT,
    preferred_actions TEXT,
    metadata JSON
);

CREATE TABLE IF NOT EXISTS automation_blueprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    ha_payload JSON,
    worker_payload JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name TEXT NOT NULL,
    trigger_type TEXT,
    trigger_config JSON,
    response_template TEXT,
    last_triggered DATETIME
);

CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron TEXT NOT NULL,
    task TEXT NOT NULL,
    configuration JSON,
    enabled INTEGER DEFAULT 1
);
