-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('PHASE_CHANGE', 'SUBAGENT_STARTED', 'SUBAGENT_COMPLETED', 'PLAN_GENERATED', 'REVIEW_COMPLETED', 'CI_CHECK', 'ERROR', 'TASK_SUMMARY');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514';

-- CreateTable
CREATE TABLE "task_activities" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "metadata" JSONB,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_activities_task_id_created_at_idx" ON "task_activities"("task_id", "created_at");

-- AddForeignKey
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
