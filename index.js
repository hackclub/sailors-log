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

async function getUserSummary(apiKey) {
  const base64Key = Buffer.from(apiKey).toString('base64');
  const response = await fetch('https://waka.hackclub.com/api/summary?interval=today&recompute=true', {
    headers: {
      'Authorization': `Basic ${base64Key}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function calculateTotalMinutes(summary) {
  return Math.round(
    (summary.languages || [])
      .reduce((total, lang) => total + lang.total, 0) / 60
  );
}

function isSameDay(date1, date2) {
  return date1.toISOString().split('T')[0] === date2.toISOString().split('T')[0];
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
    console.log('\nFetching activity summaries...');
    
    for (const [userId, apiKey] of apiKeys) {
      try {
        const userAlert = monitoredUsers.find(u => u.hackatimeUserId === userId);
        const summary = await getUserSummary(apiKey);
        const totalMinutes = calculateTotalMinutes(summary);
        const now = new Date();

        console.log(`\nActivity summary for ${userId}:`);
        
        // Check if we're on a new day
        if (!isSameDay(now, userAlert.lastCheckAt)) {
          console.log('New day detected, resetting previous total');
          await prisma.codingActivityAlert.update({
            where: { id: userAlert.id },
            data: { 
              lastTotalMinutes: 0,
              lastCheckAt: now
            }
          });
          userAlert.lastTotalMinutes = 0;
        }

        // Calculate and display minutes coded since last check
        const newMinutes = totalMinutes - userAlert.lastTotalMinutes;
        if (newMinutes > 0) {
          console.log(`Coded ${newMinutes} new minutes since last check`);
        }
        
        // Display current activity
        if (summary.projects?.length > 0) {
          console.log('Projects:');
          summary.projects.forEach(p => {
            const minutes = Math.round(p.total / 60);
            console.log(`  ${p.key}: ${minutes} minutes`);
          });
        }
        
        if (summary.languages?.length > 0) {
          console.log('Languages:');
          summary.languages.forEach(l => {
            const minutes = Math.round(l.total / 60);
            console.log(`  ${l.key}: ${minutes} minutes`);
          });
        }

        // Update stored total
        await prisma.codingActivityAlert.update({
          where: { id: userAlert.id },
          data: { 
            lastTotalMinutes: totalMinutes,
            lastCheckAt: now
          }
        });
      } catch (error) {
        console.error(`Failed to get summary for ${userId}:`, error.message);
      }
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
