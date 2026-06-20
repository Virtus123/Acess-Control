-- Migration: create person_groups join table for many-to-many persons <-> groups

CREATE TABLE IF NOT EXISTS person_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    UNIQUE(person_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_person_groups_person ON person_groups(person_id);
CREATE INDEX IF NOT EXISTS idx_person_groups_group ON person_groups(group_id);
