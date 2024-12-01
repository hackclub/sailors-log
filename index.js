import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Initialize databases
const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
const prisma = new PrismaClient();

const POLL_INTERVAL = 5 * 1000; // 5 seconds
const RETENTION_HOURS = 24;

async function getUserApiKey(userId) {
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

async function fetchUserSummary(apiKey) {
  try {
    const response = await fetch('https://waka.hackclub.com/api/summary?interval=all_time&recompute=true', {
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${Buffer.from(apiKey).toString('base64')}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching user summary:', error);
    return null;
  }
}

async function checkProjectMilestones(userId, summary) {
  const projects = summary.projects || [];
  const notifications = [];

  for (const project of projects) {
    const projectName = project.key;
    const totalSeconds = project.total;

    // Get last notification for this user-project
    const lastNotification = await prisma.projectNotification.findUnique({
      where: {
        user_id_project_name: {
          user_id: userId,
          project_name: projectName
        }
      }
    });

    if (!lastNotification) {
      // First time seeing this project, create initial notification record
      await prisma.projectNotification.create({
        data: {
          user_id: userId,
          project_name: projectName,
          last_notified_at: new Date(),
          last_total_seconds: totalSeconds
        }
      });
      continue;
    }

    // Calculate seconds coded since last notification
    const secondsSinceNotification = totalSeconds - lastNotification.last_total_seconds;
    
    // Check if they've coded for an hour (3600 seconds) since last notification
    if (secondsSinceNotification >= 3600) {
      const hours = Math.floor(secondsSinceNotification / 3600);
      notifications.push({
        project: projectName,
        hours,
        total_hours: Math.floor(totalSeconds / 3600)
      });

      // Update the notification record
      await prisma.projectNotification.update({
        where: {
          id: lastNotification.id
        },
        data: {
          last_notified_at: new Date(),
          last_total_seconds: totalSeconds
        }
      });
    }
  }

  return notifications;
}

async function processNewHeartbeats(heartbeats) {
  // Group heartbeats by user
  const userHeartbeats = heartbeats.reduce((acc, hb) => {
    (acc[hb.user_id] = acc[hb.user_id] || []).push(hb);
    return acc;
  }, {});

  // Process each user's heartbeats
  for (const [userId, beats] of Object.entries(userHeartbeats)) {
    const apiKey = await getUserApiKey(userId);
    if (!apiKey) {
      console.log(`No API key found for user ${userId}`);
      continue;
    }

    console.log(`Fetching summary for user ${userId}`);
    const summary = await fetchUserSummary(apiKey);
    if (summary) {
      console.log(`Summary for user ${userId}:`, JSON.stringify(summary, null, 2));
      
      // Check for project milestones
      const notifications = await checkProjectMilestones(userId, summary);
      
      // Log notifications (you can replace this with actual notifications later)
      for (const notification of notifications) {
        console.log(`🎉 User ${userId} has coded ${notification.hours} more hours in ${notification.project}! ` +
                   `Total: ${notification.total_hours} hours`);
      }
    }
  }
}

async function cleanupOldHeartbeats() {
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);
  const { count } = await prisma.syncedHeartbeat.deleteMany({
    where: {
      created_at: {
        lt: cutoff
      }
    }
  });
  
  if (count > 0) {
    console.log(`Cleaned up ${count} heartbeats older than ${RETENTION_HOURS} hours`);
  }
}

async function storeHeartbeats(heartbeats) {
  if (heartbeats.length === 0) return;

  const results = await Promise.allSettled(
    heartbeats.map(hb => {
      // Convert Unix timestamp to DateTime with validation
      let time;
      try {
        // Ensure we have a valid number
        const timestamp = typeof hb.time === 'string' ? parseFloat(hb.time) : hb.time;
        if (!isFinite(timestamp)) {
          throw new Error(`Invalid timestamp: ${hb.time}`);
        }
        // Convert timestamp to Date assuming hb.time is in milliseconds
        time = new Date(timestamp);
        
        // Validate the resulting date
        if (time.toString() === 'Invalid Date' || time.getFullYear() < 2000 || time.getFullYear() > 2100) {
          throw new Error(`Invalid date result: ${time} from timestamp ${timestamp}`);
        }
      } catch (error) {
        console.error(`Error converting timestamp for heartbeat ${hb.id}:`, error);
        console.error('Heartbeat data:', hb);
        throw error;
      }

      const data = {
        id: hb.id,
        user_id: hb.user_id,
        entity: hb.entity,
        type: hb.type,
        category: hb.category,
        project: hb.project,
        branch: hb.branch,
        language: hb.language,
        is_write: hb.is_write || false,
        editor: hb.editor,
        operating_system: hb.operating_system,
        machine: hb.machine,
        user_agent: hb.user_agent,
        time,
        hash: hb.hash,
        origin: hb.origin,
        origin_id: hb.origin_id,
        created_at: hb.created_at,
        project_root_count: parseInt(hb.project_root_count, 10),
        line_additions: parseInt(hb.line_additions, 10),
        line_deletions: parseInt(hb.line_deletions, 10),
        lines: parseInt(hb.lines, 10),
        line_number: parseInt(hb.line_number, 10),
        cursor_position: parseInt(hb.cursor_position, 10),
        dependencies: hb.dependencies
      };

      return prisma.syncedHeartbeat.upsert({
        where: { id: hb.id },
        create: data,
        update: data
      });
    })
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  if (succeeded > 0) {
    console.log(`Stored ${succeeded} new heartbeats`);
    // Process new heartbeats for API requests
    await processNewHeartbeats(heartbeats);
  }
  if (failed > 0) {
    console.log(`Failed to store ${failed} heartbeats`);
    results
      .filter(r => r.status === 'rejected')
      .forEach(r => console.error('Storage error:', r.reason));
  }
}

async function getHeartbeats() {
  const client = await hackatime.connect();
  
  try {
    // Get last processed heartbeat time from SyncedHeartbeat
    const lastHeartbeat = await prisma.syncedHeartbeat.findFirst({
      orderBy: { created_at: 'desc' }
    });

    // Get cutoff time (24 hours ago)
    const cutoffTime = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);

    let startTime;
    if (!lastHeartbeat?.created_at || lastHeartbeat.created_at < cutoffTime) {
      // If no last heartbeat or it's too old, just get recent heartbeats
      startTime = new Date(Date.now() - POLL_INTERVAL);
      console.log('No recent heartbeats, fetching last poll interval:', startTime.toISOString());
    } else {
      // Otherwise, continue from last heartbeat
      startTime = lastHeartbeat.created_at;
      console.log('Fetching heartbeats since:', startTime.toISOString());
    }

    // Build query with time constraint
    const query = {
      text: 'SELECT * FROM heartbeats WHERE created_at > $1 ORDER BY created_at DESC',
      values: [startTime]
    };

    // Get new heartbeats
    const { rows } = await client.query(query);
    if (rows.length > 0) {
      console.log(`Found ${rows.length} new heartbeats`);
      await storeHeartbeats(rows);
    }

    return rows;
  } finally {
    client.release();
  }
}

async function pollHeartbeats() {
  try {
    await getHeartbeats();
    await cleanupOldHeartbeats();
  } catch (error) {
    console.error('Error during poll:', error);
  }
}

// Start polling
console.log(`Starting heartbeat polling every ${POLL_INTERVAL/1000} seconds...`);

// Initial poll
await pollHeartbeats();

// Set up regular polling
const pollInterval = setInterval(pollHeartbeats, POLL_INTERVAL);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  clearInterval(pollInterval);
  await Promise.all([
    prisma.$disconnect(),
    hackatime.end()
  ]);
  process.exit(0);
});
