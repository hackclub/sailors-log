import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Initialize databases
const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
const prisma = new PrismaClient();

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
