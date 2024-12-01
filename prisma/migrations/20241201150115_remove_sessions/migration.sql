-- CreateTable
CREATE TABLE "LastHeartbeat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "heartbeat_created_at" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CodingActivityAlert" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hackatime_user_id" TEXT NOT NULL,
    "last_total_minutes" INTEGER NOT NULL DEFAULT 0,
    "last_check_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncedHeartbeat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "entity" TEXT,
    "type" TEXT,
    "category" TEXT,
    "project" TEXT,
    "branch" TEXT,
    "language" TEXT,
    "is_write" BOOLEAN NOT NULL DEFAULT false,
    "editor" TEXT,
    "operating_system" TEXT,
    "machine" TEXT,
    "user_agent" TEXT,
    "time" DATETIME NOT NULL,
    "hash" TEXT,
    "origin" TEXT,
    "origin_id" TEXT,
    "created_at" DATETIME NOT NULL,
    "project_root_count" INTEGER,
    "line_additions" INTEGER,
    "line_deletions" INTEGER,
    "lines" INTEGER,
    "line_number" INTEGER,
    "cursor_position" INTEGER,
    "dependencies" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "CodingActivityAlert_hackatime_user_id_key" ON "CodingActivityAlert"("hackatime_user_id");

-- CreateIndex
CREATE INDEX "SyncedHeartbeat_created_at_idx" ON "SyncedHeartbeat"("created_at");

-- CreateIndex
CREATE INDEX "SyncedHeartbeat_user_id_idx" ON "SyncedHeartbeat"("user_id");

-- CreateIndex
CREATE INDEX "SyncedHeartbeat_time_idx" ON "SyncedHeartbeat"("time");
