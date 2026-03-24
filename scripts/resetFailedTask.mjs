import 'dotenv/config';
import { PrismaClient, TaskStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const failed = await prisma.task.findFirst({
    where: { status: TaskStatus.FAILED },
    orderBy: { updatedAt: 'desc' },
  });

  if (!failed) {
    console.log('No failed tasks found.');
    return;
  }

  console.log(`Found failed task: ${failed.id} (${failed.title}) — resetting to PENDING_APPROVAL`);

  const updated = await prisma.task.update({
    where: { id: failed.id },
    data: { status: TaskStatus.PENDING_APPROVAL, errorLog: null },
  });

  console.log('Task updated:', updated.id, updated.status);
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
