import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Initialize databases
export const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
export const prisma = new PrismaClient();

export async function getUserApiKey(userId) {
  const client = await hackatime.connect();
  try {
    const { rows } = await client.query(
      'SELECT api_key FROM users WHERE id = $1',
      [userId]
    );
    return rows[0]?.api_key;
  } finally {
    client.release();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down databases...');
  await Promise.all([
    prisma.$disconnect(),
    hackatime.end()
  ]);
}); 