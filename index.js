import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Initialize databases
const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
const prisma = new PrismaClient();

async function addUserToAlert(hackatimeUserId) {
  try {
    const alert = await prisma.codingActivityAlert.create({
      data: { hackatimeUserId }
    });
    console.log(`Added user ${hackatimeUserId} to alerts`);
    return alert;
  } catch (error) {
    if (error.code === 'P2002') {
      console.log(`User ${hackatimeUserId} is already being monitored`);
      return null;
    }
    throw error;
  }
}

async function getApiKeys(userIds) {
  if (userIds.length === 0) return new Map();

  const query = {
    text: 'SELECT id, api_key FROM users WHERE id = ANY($1)',
    values: [Array.from(userIds)]
  };

  const { rows } = await hackatime.query(query);
  return new Map(rows.map(row => [row.id, row.api_key]));
}

async function checkMonitoredUsers(heartbeats) {
  // Get all monitored users
  const monitoredUsers = await prisma.codingActivityAlert.findMany();
  const monitoredUserIds = new Set(monitoredUsers.map(u => u.hackatimeUserId));

  // Get unique active monitored users
  const activeMonitoredUsers = new Set(
    heartbeats
      .filter(hb => monitoredUserIds.has(hb.user_id))
      .map(hb => hb.user_id)
  );
  
  if (activeMonitoredUsers.size > 0) {
    console.log('\nActive monitored users:', Array.from(activeMonitoredUsers).join(', '));
    
    // Get API keys for active users
    const apiKeys = await getApiKeys(activeMonitoredUsers);
    console.log('\nAPI Keys:');
    for (const [userId, apiKey] of apiKeys) {
      console.log(`${userId}: ${apiKey}`);
    }
  }
}

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

    // Check for monitored users
    if (rows.length > 0) {
      await checkMonitoredUsers(rows);
      
      // Update last processed time
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

// Example usage:
if (process.argv[2] === 'add-user') {
  const userId = process.argv[3];
  if (!userId) {
    console.error('Please provide a user ID');
    process.exit(1);
  }
  
  try {
    await addUserToAlert(userId);
  } catch (error) {
    console.error('Error adding user:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
} else {
  // Regular heartbeat checking
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
}
