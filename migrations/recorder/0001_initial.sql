-- Recorder schema clone for Home Assistant compatible queries
CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    event_data TEXT,
    origin TEXT,
    time_fired DATETIME,
    context_id TEXT,
    context_user_id TEXT,
    context_parent_id TEXT
);

CREATE INDEX IF NOT EXISTS ix_events_time_fired ON events(time_fired);
CREATE INDEX IF NOT EXISTS ix_events_event_type ON events(event_type);

CREATE TABLE IF NOT EXISTS states (
    state_id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    state TEXT,
    attributes TEXT,
    event_id INTEGER,
    last_changed DATETIME,
    last_updated DATETIME,
    old_state_id INTEGER,
    UNIQUE(entity_id, last_updated)
);

CREATE INDEX IF NOT EXISTS ix_states_entity_id_last_updated ON states(entity_id, last_updated);
CREATE INDEX IF NOT EXISTS ix_states_last_updated ON states(last_updated);

CREATE TABLE IF NOT EXISTS statistics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metadata_id INTEGER NOT NULL,
    start DATETIME NOT NULL,
    mean FLOAT,
    min FLOAT,
    max FLOAT,
    last_reset DATETIME,
    state TEXT,
    sum FLOAT
);

CREATE TABLE IF NOT EXISTS statistics_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statistic_id TEXT UNIQUE,
    unit_of_measurement TEXT,
    source TEXT,
    name TEXT
);

CREATE TABLE IF NOT EXISTS statistics_short_term (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metadata_id INTEGER NOT NULL,
    start DATETIME NOT NULL,
    mean FLOAT,
    min FLOAT,
    max FLOAT,
    last_reset DATETIME,
    state TEXT,
    sum FLOAT
);

CREATE VIEW IF NOT EXISTS statistics_during_period AS
SELECT s.*, m.statistic_id, m.unit_of_measurement, m.name
FROM statistics s
JOIN statistics_meta m ON s.metadata_id = m.id;
