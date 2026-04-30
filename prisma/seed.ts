import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error('ADMIN_PASSWORD env var is required to seed the admin user');
  }

  const email = process.env.ADMIN_EMAIL ?? 'admin@ispcrm.com';
  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: 'Admin',
      role: 'ADMIN',
      passwordHash,
    },
    update: {
      passwordHash,
    },
  });

  console.log(`Seeded ADMIN user: ${admin.email} (${admin.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
