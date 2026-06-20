-- Migration: Create parkings and parking_spots tables
-- Creates tables for parking management (rotative and fixed)

PRAGMA foreign_keys=OFF;

-- Table for parking lots
CREATE TABLE IF NOT EXISTS parkings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('rotativo', 'fixo')),
    total_spots INTEGER DEFAULT NULL,
    active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Table for parking spots (only for fixed type)
CREATE TABLE IF NOT EXISTS parking_spots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parking_id INTEGER NOT NULL,
    spot_number TEXT NOT NULL,
    status TEXT DEFAULT 'available' CHECK(status IN ('available', 'occupied', 'reserved', 'maintenance')),
    person_id INTEGER,
    vehicle_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parking_id) REFERENCES parkings(id) ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES persons(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    UNIQUE(parking_id, spot_number)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_parkings_type ON parkings(type);
CREATE INDEX IF NOT EXISTS idx_parkings_active ON parkings(active);
CREATE INDEX IF NOT EXISTS idx_parking_spots_parking_id ON parking_spots(parking_id);
CREATE INDEX IF NOT EXISTS idx_parking_spots_status ON parking_spots(status);
CREATE INDEX IF NOT EXISTS idx_parking_spots_person_id ON parking_spots(person_id);

PRAGMA foreign_keys=ON;
