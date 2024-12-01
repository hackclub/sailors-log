-- CreateTable
CREATE TABLE "UserSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "summary_data" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "UserSummary_user_id_idx" ON "UserSummary"("user_id");

-- CreateIndex
CREATE INDEX "UserSummary_created_at_idx" ON "UserSummary"("created_at");
