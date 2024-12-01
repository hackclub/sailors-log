-- CreateTable
CREATE TABLE "SyncedHeartbeat" (
    "id" TEXT PRIMARY KEY,
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
    "time" TIMESTAMP NOT NULL,
    "hash" TEXT,
    "origin" TEXT,
    "origin_id" TEXT,
    "created_at" TIMESTAMP NOT NULL,
    "project_root_count" INTEGER,
    "line_additions" INTEGER,
    "line_deletions" INTEGER,
    "lines" INTEGER,
    "line_number" INTEGER,
    "cursor_position" INTEGER,
    "dependencies" TEXT
);

-- CreateTable
CREATE TABLE "ProjectNotification" (
    "id" TEXT PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "project_name" TEXT NOT NULL,
    "last_notified_at" TIMESTAMP NOT NULL,
    "last_total_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP NOT NULL
);

-- CreateTable
CREATE TABLE "SlackNotificationPreference" (
    "id" TEXT PRIMARY KEY,
    "slack_user_id" TEXT NOT NULL,
    "slack_channel_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP NOT NULL
);

-- CreateTable
CREATE TABLE "UserCodingTime" (
    "id" TEXT PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "date" TIMESTAMP NOT NULL,
    "total_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP NOT NULL
);

-- CreateIndex
CREATE INDEX "SyncedHeartbeat_created_at_idx" ON "SyncedHeartbeat"("created_at");

-- CreateIndex
CREATE INDEX "SyncedHeartbeat_user_id_idx" ON "SyncedHeartbeat"("user_id");

-- CreateIndex
CREATE INDEX "SyncedHeartbeat_time_idx" ON "SyncedHeartbeat"("time");

-- CreateIndex
CREATE INDEX "ProjectNotification_user_id_idx" ON "ProjectNotification"("user_id");

-- CreateIndex
CREATE INDEX "ProjectNotification_last_notified_at_idx" ON "ProjectNotification"("last_notified_at");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectNotification_user_id_project_name_key" ON "ProjectNotification"("user_id", "project_name");

-- CreateIndex
CREATE INDEX "SlackNotificationPreference_slack_user_id_idx" ON "SlackNotificationPreference"("slack_user_id");

-- CreateIndex
CREATE INDEX "SlackNotificationPreference_slack_channel_id_idx" ON "SlackNotificationPreference"("slack_channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "SlackNotificationPreference_slack_user_id_slack_channel_id_key" ON "SlackNotificationPreference"("slack_user_id", "slack_channel_id");

-- CreateIndex
CREATE INDEX "UserCodingTime_user_id_idx" ON "UserCodingTime"("user_id");

-- CreateIndex
CREATE INDEX "UserCodingTime_date_idx" ON "UserCodingTime"("date");

-- CreateIndex
CREATE UNIQUE INDEX "UserCodingTime_user_id_date_key" ON "UserCodingTime"("user_id", "date");
