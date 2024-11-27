import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Initialize databases
const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
const prisma = new PrismaClient();

const POLL_INTERVAL = 5 * 1000; // 30 seconds
const RETENTION_HOURS = 24;
const SESSION_TIMEOUT = 2 * 60; // 2 minutes in seconds

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

async function updateSessions(heartbeats) {
  if (heartbeats.length === 0) return;

  // Group heartbeats by user
  const heartbeatsByUser = heartbeats.reduce((acc, hb) => {
    (acc[hb.user_id] = acc[hb.user_id] || []).push(hb);
    return acc;
  }, {});

  // Process each user's heartbeats
  for (const [userId, userHeartbeats] of Object.entries(heartbeatsByUser)) {
    // Sort heartbeats by time
    const sortedHeartbeats = userHeartbeats.sort((a, b) => a.time - b.time);
    
    // Get user's most recent session
    let currentSession = await prisma.session.findFirst({
      where: {
        user_id: userId,
        is_active: true
      },
      include: {
        heartbeats: {
          orderBy: {
            time: 'desc'
          },
          take: 1
        }
      }
    });

    for (const heartbeat of sortedHeartbeats) {
      const heartbeatTime = typeof heartbeat.time === 'string' || heartbeat.time instanceof Date
        ? new Date(heartbeat.time).getTime() / 1000
        : heartbeat.time;

      if (!currentSession) {
        // Start new session
        currentSession = await createNewSession(heartbeat);
        continue;
      }

      // Get the time of the most recent heartbeat in the session
      const lastHeartbeatTime = currentSession.heartbeats[0]?.time ?? currentSession.start_time;
      const timeSinceLastHeartbeat = heartbeatTime - lastHeartbeatTime;

      if (timeSinceLastHeartbeat > SESSION_TIMEOUT) {
        // Close the current session at its last heartbeat time
        await closeSession(currentSession.id);
        // Start new session with this heartbeat
        currentSession = await createNewSession(heartbeat);
      } else {
        // Update existing session with this heartbeat
        await updateSession(currentSession.id, heartbeat);
      }
    }
  }
}

async function createNewSession(heartbeat) {
  const time = typeof heartbeat.time === 'string' || heartbeat.time instanceof Date
    ? new Date(heartbeat.time).getTime() / 1000
    : heartbeat.time;

  return prisma.session.create({
    data: {
      user_id: heartbeat.user_id,
      start_time: time,
      end_time: time,
      minutes: 0,
      heartbeats_count: 1,
      projects: JSON.stringify([heartbeat.project].filter(Boolean)),
      languages: JSON.stringify([heartbeat.language].filter(Boolean)),
      editors: JSON.stringify([heartbeat.editor].filter(Boolean)),
      heartbeats: {
        connect: { id: heartbeat.id }
      }
    },
    include: {
      heartbeats: {
        orderBy: {
          time: 'desc'
        },
        take: 1
      }
    }
  });
}

async function updateSession(sessionId, heartbeat) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId }
  });

  const time = typeof heartbeat.time === 'string' || heartbeat.time instanceof Date
    ? new Date(heartbeat.time).getTime() / 1000
    : heartbeat.time;

  // Update session metadata
  const projects = new Set(JSON.parse(session.projects));
  const languages = new Set(JSON.parse(session.languages));
  const editors = new Set(JSON.parse(session.editors));

  if (heartbeat.project) projects.add(heartbeat.project);
  if (heartbeat.language) languages.add(heartbeat.language);
  if (heartbeat.editor) editors.add(heartbeat.editor);

  // Calculate minutes from session start to this heartbeat
  const minutes = Math.max(0, (time - session.start_time) / 60);

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      end_time: time,
      minutes,
      heartbeats_count: { increment: 1 },
      projects: JSON.stringify(Array.from(projects)),
      languages: JSON.stringify(Array.from(languages)),
      editors: JSON.stringify(Array.from(editors)),
      heartbeats: {
        connect: { id: heartbeat.id }
      }
    }
  });
}

async function closeSession(sessionId) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      heartbeats: {
        orderBy: {
          time: 'desc'
        },
        take: 1
      }
    }
  });

  // Calculate final duration using the last heartbeat's time
  const lastHeartbeatTime = session.heartbeats[0]?.time ?? session.end_time;
  const minutes = Math.max(0, (lastHeartbeatTime - session.start_time) / 60);

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      is_active: false,
      end_time: lastHeartbeatTime,
      minutes
    }
  });
}

async function storeHeartbeats(heartbeats) {
  if (heartbeats.length === 0) return;

  const results = await Promise.allSettled(
    heartbeats.map(hb => {
      // Convert time to float timestamp if it's a date
      const time = hb.time instanceof Date ? 
        hb.time.getTime() / 1000 : 
        typeof hb.time === 'string' ? 
          new Date(hb.time).getTime() / 1000 : 
          hb.time;

      // Helper function to convert string/null to integer
      const toInt = (val) => {
        if (val === null || val === undefined || val === '') return null;
        const num = parseInt(val, 10);
        return isNaN(num) ? null : num;
      };

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
        project_root_count: toInt(hb.project_root_count),
        line_additions: toInt(hb.line_additions),
        line_deletions: toInt(hb.line_deletions),
        lines: toInt(hb.lines),
        line_number: toInt(hb.line_number),
        cursor_position: toInt(hb.cursor_position),
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
    // Update sessions after storing heartbeats
    await updateSessions(heartbeats);
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
    // Get last processed heartbeat time
    const lastHeartbeat = await prisma.lastHeartbeat.findFirst();
    console.log('Last processed:', lastHeartbeat?.heartbeatCreatedAt?.toISOString() ?? 'None');

    // Build query
    const query = lastHeartbeat ? {
      text: 'SELECT * FROM heartbeats WHERE created_at > $1 ORDER BY created_at DESC',
      values: [lastHeartbeat.heartbeatCreatedAt]
    } : {
      text: 'SELECT * FROM heartbeats WHERE created_at > NOW() - INTERVAL \'5 minutes\' ORDER BY created_at DESC'
    };

    // Get new heartbeats
    const { rows } = await client.query(query);
    if (rows.length > 0) {
      console.log(`Found ${rows.length} new heartbeats`);
      
      // Store the heartbeats
      await storeHeartbeats(rows);
      
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

async function pollHeartbeats() {
  try {
    await getHeartbeats();
    await cleanupOldHeartbeats();
  } catch (error) {
    console.error('Error during poll:', error);
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
}
