-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'IN_PROGRESS', 'WAITING_FOR_PLAN_APPROVAL', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TaskScenario" AS ENUM ('SMALL', 'MEDIUM', 'COMPLEX');

-- CreateEnum
CREATE TYPE "PlanApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskPhase" AS ENUM ('CLASSIFY', 'PLAN', 'PLAN_DRAFT', 'WAITING_FOR_PLAN_APPROVAL', 'IMPLEMENT', 'REVIEW', 'REWORK', 'CREATE_PR', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "MemoryCategory" AS ENUM ('PATTERN', 'MISTAKE', 'CONVENTION', 'GOTCHA');

-- CreateEnum
CREATE TYPE "MemorySource" AS ENUM ('HUMAN_FEEDBACK', 'AUTO_DETECTED', 'MANUAL');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "repo_url" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'DRAFT',
    "scenario" "TaskScenario",
    "phase" "TaskPhase",
    "classification_reason" TEXT,
    "plan_approval_status" "PlanApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "plan_content" JSONB,
    "copilot_session_id" TEXT,
    "copilot_workspace_path" TEXT,
    "working_directory" TEXT,
    "branch" TEXT,
    "pr_url" TEXT,
    "result" TEXT,
    "error_log" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_activity_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_logs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "phase" "TaskPhase",
    "agent_name" TEXT,
    "tool_name" TEXT,
    "tool_args" JSONB,
    "payload" JSONB,
    "result" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_memory" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "category" "MemoryCategory" NOT NULL,
    "content" TEXT NOT NULL,
    "source" "MemorySource" NOT NULL,
    "task_id" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "times_reinforced" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_feedback" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "what_went_wrong" TEXT,
    "what_went_right" TEXT,
    "lessons_learned" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secrets" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "env_blob" TEXT NOT NULL,
    "key_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_project_id_idx" ON "tasks"("project_id");

-- CreateIndex
CREATE INDEX "execution_logs_task_id_idx" ON "execution_logs"("task_id");

-- CreateIndex
CREATE INDEX "project_memory_project_id_is_active_idx" ON "project_memory"("project_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_owner_repo_key" ON "secrets"("owner", "repo");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory" ADD CONSTRAINT "project_memory_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_feedback" ADD CONSTRAINT "task_feedback_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
