import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Initialize databases
const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
const prisma = new PrismaClient();

async function getHeartbeats() {
  const client = await hackatime.connect();
  
  try {
    // Get last processed heartbeat time
    const lastHeartbeat = await prisma.lastHeartbeat.findFirst();
    console.log('Last processed:', lastHeartbeat?.heartbeatCreatedAt?.toISOString() ?? 'None');

    // Build query
    const query = lastHeartbeat ? {
      text: 'SELECT * FROM heartbeats WHERE created_at > $1 ORDER BY created_at DESC',
      values: [lastHeartbeat.heartbeatCreatedAt]
    } : {
      text: 'SELECT * FROM heartbeats ORDER BY created_at DESC LIMIT 1'
    };

    // Get new heartbeats
    const { rows } = await client.query(query);
    console.log(`Found ${rows.length} new heartbeats`);

    // Update last processed time if we found any heartbeats
    if (rows.length > 0) {
      await prisma.lastHeartbeat.upsert({
        where: { id: 1 },
        create: { id: 1, heartbeatCreatedAt: rows[0].created_at },
        update: { heartbeatCreatedAt: rows[0].created_at }
      });
    }

    return rows;
  } finally {
    client.release();
  }
}

// Run and cleanup
try {
  const heartbeats = await getHeartbeats();
  console.log(`Processed ${heartbeats.length} heartbeats`);
} catch (error) {
  console.error('Error:', error);
  process.exitCode = 1;
} finally {
  await Promise.all([
    prisma.$disconnect(),
    hackatime.end()
  ]);
}
