import { hackatime, prisma, getUserApiKey } from './db.js';
import slackServer from './slack.js';

// Load environment variables from .env file
const envPath = process.env.ENV_PATH || '.env';
await import('dotenv').then(dotenv => dotenv.config({ path: envPath }));

// Constants
const POLL_INTERVAL = 5 * 1000; // 5 seconds
const RETENTION_HOURS = 24;

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
    // Process new heartbeats for notifications
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
  console.log('Connecting to hackatime database...');
  const client = await hackatime.connect();
  
  try {
    // Get last processed heartbeat time from SyncedHeartbeat
    console.log('Finding last synced heartbeat...');
    const lastHeartbeat = await prisma.syncedHeartbeat.findFirst({
      orderBy: { created_at: 'desc' }
    });

    // Get cutoff time (24 hours ago)
    const cutoffTime = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);

    let query;
    if (!lastHeartbeat?.created_at) {
      // If no heartbeats synced yet, get the 500 most recent ones
      query = {
        text: 'SELECT * FROM heartbeats ORDER BY created_at DESC LIMIT 500',
        values: []
      };
      console.log('No heartbeats found, fetching 500 most recent heartbeats');
    } else if (lastHeartbeat.created_at < cutoffTime) {
      // If last heartbeat is too old, get recent ones
      const startTime = new Date(Date.now() - POLL_INTERVAL);
      query = {
        text: 'SELECT * FROM heartbeats WHERE created_at > $1 ORDER BY created_at DESC',
        values: [startTime]
      };
      console.log('Last heartbeat too old, fetching from:', startTime.toISOString());
    } else {
      // Continue from last heartbeat
      query = {
        text: 'SELECT * FROM heartbeats WHERE created_at > $1 ORDER BY created_at DESC',
        values: [lastHeartbeat.created_at]
      };
      console.log('Fetching heartbeats since:', lastHeartbeat.created_at.toISOString());
    }

    console.log('Executing query:', query);

    // Get new heartbeats
    console.log('Fetching heartbeats from hackatime...');
    const { rows } = await client.query(query);
    console.log(`Query complete. Found ${rows.length} heartbeats.`);

    if (rows.length > 0) {
      console.log('Processing heartbeats...');
      await storeHeartbeats(rows);
      console.log('Finished processing heartbeats.');
    }

    return rows;
  } catch (error) {
    console.error('Error in getHeartbeats:', error);
    throw error;
  } finally {
    console.log('Releasing database connection...');
    await client.release();
    console.log('Database connection released.');
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

async function fetchUserSummary(apiKey) {
  try {
    const response = await fetch('https://waka.hackclub.com/api/summary?interval=all_time&recompute=true', {
      headers: {
        'accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(apiKey).toString('base64')}`
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

async function processNewHeartbeats(heartbeats) {
  console.log('Processing new heartbeats...');
  // Group heartbeats by user
  const userHeartbeats = heartbeats.reduce((acc, hb) => {
    (acc[hb.user_id] = acc[hb.user_id] || []).push(hb);
    return acc;
  }, {});

  console.log(`Processing heartbeats for ${Object.keys(userHeartbeats).length} users`);

  // Process each user's heartbeats
  for (const [userId, beats] of Object.entries(userHeartbeats)) {
    console.log(`Processing ${beats.length} heartbeats for user ${userId}`);
    
    // Auto-subscribe user to default channel if not already subscribed
    const defaultChannel = process.env.SLACK_CHANNEL_HEIDIS_SPYGLASS;
    if (defaultChannel) {
      const existingPref = await prisma.slackNotificationPreference.findUnique({
        where: {
          slack_user_id_slack_channel_id: {
            slack_user_id: userId,
            slack_channel_id: defaultChannel
          }
        }
      });

      if (!existingPref) {
        try {
          await prisma.slackNotificationPreference.create({
            data: {
              slack_user_id: userId,
              slack_channel_id: defaultChannel,
              enabled: true
            }
          });
          console.log(`Auto-subscribed user ${userId} to notifications in channel ${defaultChannel}`);
        } catch (error) {
          console.error(`Failed to auto-subscribe user ${userId}:`, error);
        }
      }
    }

    // Get API key and process coding time
    const apiKey = await getUserApiKey(userId);
    if (!apiKey) {
      console.log(`No API key found for user ${userId}`);
      continue;
    }

    console.log(`Fetching summary for user ${userId}`);
    const summary = await fetchUserSummary(apiKey);
    if (summary) {
      // Store the summary in the database
      try {
        await prisma.userSummary.create({
          data: {
            user_id: userId,
            summary_data: JSON.stringify(summary)
          }
        });
        console.log(`Stored summary for user ${userId}`);
      } catch (error) {
        console.error(`Failed to store summary for user ${userId}:`, error);
      }
    }
  }
  console.log('Finished processing all heartbeats');
}

console.log('Starting Heidi\'s Spyglass...');

// Log that Slack server is ready
console.log(`Slack server listening on port ${slackServer.port}`);

// Start heartbeat polling
console.log(`Starting heartbeat polling every ${POLL_INTERVAL/1000} seconds...`);
await pollHeartbeats(); // Initial poll
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
