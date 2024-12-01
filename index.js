import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Load environment variables from .env file
const envPath = process.env.ENV_PATH || '.env';
await import('dotenv').then(dotenv => dotenv.config({ path: envPath }));

// Initialize databases
const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
const prisma = new PrismaClient();

// Constants
const POLL_INTERVAL = 5 * 1000; // 5 seconds
const RETENTION_HOURS = 24;
const NOTIFICATION_PERIOD_SECONDS = 3600; // 1 hour
// const NOTIFICATION_PERIOD_SECONDS = 60 * 5;
const port = process.env.PORT || 3000;

// Verify Slack requests are genuine using signing secret
async function verifySlackRequest(req) {
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  if (!slackSigningSecret) {
    throw new Error('SLACK_SIGNING_SECRET environment variable is not set');
  }

  const timestamp = req.headers.get('x-slack-request-timestamp');
  const slackSignature = req.headers.get('x-slack-signature');
  
  // Check if request is older than 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) {
    throw new Error('Request is too old');
  }

  // Get the raw body from FormData
  const formData = await req.formData();
  const rawBody = new URLSearchParams(formData).toString();
  
  // Create the signature base string by concatenating version, timestamp, and body
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  
  // Create HMAC SHA256 hash using signing secret as key
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(slackSigningSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const signature_bytes = await crypto.subtle.sign(
    "HMAC",
    hmac,
    new TextEncoder().encode(sigBasestring)
  );
  
  // Convert the hash to hex
  const mySignature = 'v0=' + Array.from(new Uint8Array(signature_bytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Use crypto.timingSafeEqual to prevent timing attacks
  if (mySignature !== slackSignature) {
    console.log('Request details:', {
      timestamp,
      body: rawBody,
      baseString: sigBasestring,
      expectedSig: slackSignature,
      calculatedSig: mySignature
    });
    throw new Error('Invalid signature');
  }

  return formData;
}

async function handleSlashCommand(formData) {
  // Get command parameters from FormData
  const command = formData.get('command');
  const text = formData.get('text');
  const user_id = formData.get('user_id');
  const channel_id = formData.get('channel_id');

  console.log('Received command:', { command, text, user_id, channel_id });

  // Verify this is our command
  if (command !== '/spyglass') {
    return new Response(JSON.stringify({ error: 'Invalid command' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Parse the command
  const action = text?.trim().toLowerCase();

  // Handle empty command
  if (!action) {
    return new Response(JSON.stringify({
      response_type: 'ephemeral',
      text: 'Usage:\n' +
           '• `/spyglass on` - Enable notifications\n' +
           '• `/spyglass off` - Disable notifications\n' +
           '• `/spyglass status` - Check notification status\n' +
           '• `/spyglass leaderboard` - Show today\'s coding leaderboard\n' +
           '• `/spyglass leaderboard week` - Show this week\'s coding leaderboard'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Handle leaderboard command
    if (action === 'leaderboard' || action === 'leaderboard week') {
      console.log('Processing leaderboard command:', action);
      const period = action === 'leaderboard week' ? 'week' : 'day';
      console.log('Fetching leaderboard for period:', period);
      const message = await getLeaderboard(channel_id, period);
      
      return new Response(JSON.stringify({
        response_type: 'in_channel', // Make the response visible to everyone
        text: message
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle status check
    if (action === 'status') {
      const pref = await prisma.slackNotificationPreference.findUnique({
        where: {
          slack_user_id_slack_channel_id: {
            slack_user_id: user_id,
            slack_channel_id: channel_id
          }
        }
      });

      if (!pref) {
        return new Response(JSON.stringify({
          response_type: 'ephemeral',
          text: 'You have no notification preferences set for this channel. Notifications are disabled.'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        response_type: 'ephemeral',
        text: `Notifications are currently ${pref.enabled ? 'enabled' : 'disabled'} in this channel.`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle on/off commands
    if (action === 'on' || action === 'off') {
      const enabled = action === 'on';
      await prisma.slackNotificationPreference.upsert({
        where: {
          slack_user_id_slack_channel_id: {
            slack_user_id: user_id,
            slack_channel_id: channel_id
          }
        },
        create: {
          slack_user_id: user_id,
          slack_channel_id: channel_id,
          enabled
        },
        update: {
          enabled
        }
      });

      return new Response(JSON.stringify({
        response_type: 'ephemeral',
        text: `✅ Coding notifications have been turned ${action} in this channel.`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // If we get here, the command is unknown
    return new Response(JSON.stringify({
      response_type: 'ephemeral',
      text: 'Usage:\n' +
           '• `/spyglass on` - Enable notifications\n' +
           '• `/spyglass off` - Disable notifications\n' +
           '• `/spyglass status` - Check notification status\n' +
           '• `/spyglass leaderboard` - Show today\'s coding leaderboard\n' +
           '• `/spyglass leaderboard week` - Show this week\'s coding leaderboard'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error handling command:', error);
    return new Response(JSON.stringify({
      response_type: 'ephemeral',
      text: 'Sorry, there was an error processing your request.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
      startTime = new Date(Date.now() - POLL_INTERVAL);
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

async function sendSlackNotification(channel, message) {
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
      },
      body: JSON.stringify({
        channel,
        text: message,
        unfurl_links: false,
        unfurl_media: false
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`);
    }
  } catch (error) {
    console.error('Error sending Slack notification:', error);
  }
}

function getTimeUnit(seconds) {
  if (seconds < 60) return 'seconds';
  if (seconds < 3600) return 'minutes';
  return 'hours';
}

function formatTimeValue(seconds, unit) {
  switch (unit) {
    case 'seconds':
      return seconds;
    case 'minutes':
      return Math.floor(seconds / 60);
    case 'hours':
      return Math.floor(seconds / 3600);
    default:
      return seconds;
  }
}

function formatTotalHours(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${hours}h`;
}

async function notifyChannelsAboutCoding(userId, secondsCoded, totalSeconds, project) {
  // Find all enabled notification preferences for this user
  const preferences = await prisma.slackNotificationPreference.findMany({
    where: {
      slack_user_id: userId,
      enabled: true
    }
  });

  if (preferences.length === 0) {
    return;
  }

  // Determine time unit based on notification period
  const timeUnit = getTimeUnit(NOTIFICATION_PERIOD_SECONDS);
  const periodCount = formatTimeValue(secondsCoded, timeUnit);
  const totalTime = formatTotalHours(totalSeconds);

  const message = `🎉 <@${userId}> has reached ${periodCount} ${timeUnit} coding on *${project}*. Nice work!\nTotal: ${totalTime}`;

  // Send notification to each enabled channel
  for (const pref of preferences) {
    await sendSlackNotification(pref.slack_channel_id, message);
  }
}

async function checkAndNotifyCodingMilestones(userId, summary) {
  console.log(`Checking milestones for user ${userId}`);
  
  const projects = summary.projects || [];
  console.log(`Found ${projects.length} projects`);

  for (const project of projects) {
    const projectName = project.key;
    const totalSeconds = project.total;
    console.log(`\nChecking project: ${projectName} (${totalSeconds} seconds)`);

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
      console.log(`First time seeing project ${projectName}, creating initial record`);
      try {
        await prisma.projectNotification.create({
          data: {
            user_id: userId,
            project_name: projectName,
            last_notified_at: new Date(),
            last_total_seconds: totalSeconds
          }
        });
        console.log('Initial record created successfully');
      } catch (error) {
        console.error('Error creating initial record:', error);
      }
      continue;
    }

    // Calculate seconds coded since last notification
    const secondsSinceNotification = totalSeconds - lastNotification.last_total_seconds;
    const periodsCompleted = Math.floor(secondsSinceNotification / NOTIFICATION_PERIOD_SECONDS);
    
    // Check if they've coded for one or more complete periods
    if (periodsCompleted >= 1) {
      const timeUnit = getTimeUnit(NOTIFICATION_PERIOD_SECONDS);
      const periodSeconds = periodsCompleted * NOTIFICATION_PERIOD_SECONDS;
      console.log(`Notification threshold reached! ${formatTimeValue(periodSeconds, timeUnit)} ${timeUnit}`);
      
      // Send notifications
      await notifyChannelsAboutCoding(userId, periodSeconds, totalSeconds, projectName);

      // Update the notification record
      try {
        await prisma.projectNotification.update({
          where: {
            id: lastNotification.id
          },
          data: {
            last_notified_at: new Date(),
            last_total_seconds: totalSeconds
          }
        });
        console.log('Updated notification record successfully');
      } catch (error) {
        console.error('Error updating notification record:', error);
      }
    } else {
      const timeUnit = getTimeUnit(NOTIFICATION_PERIOD_SECONDS);
      const current = formatTimeValue(secondsSinceNotification, timeUnit);
      const needed = formatTimeValue(NOTIFICATION_PERIOD_SECONDS, timeUnit);
      console.log(`Not enough time for notification yet (${current}/${needed} ${timeUnit})`);
    }
  }
}

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

async function getLeaderboard(channel_id, period = 'day') {
  const now = new Date();
  const startDate = new Date();
  
  if (period === 'week') {
    startDate.setDate(startDate.getDate() - 7);
  } else {
    startDate.setHours(0, 0, 0, 0); // Start of today
  }

  // Get all users subscribed to this channel
  const subscribers = await prisma.slackNotificationPreference.findMany({
    where: {
      slack_channel_id: channel_id,
      enabled: true
    },
    select: {
      slack_user_id: true
    }
  });

  // Get latest summaries for all users
  const userStats = [];
  
  for (const subscriber of subscribers) {
    try {
      // Get all summaries for this user in the period
      const summaries = await prisma.userSummary.findMany({
        where: {
          user_id: subscriber.slack_user_id,
          created_at: {
            gte: startDate,
            lte: now
          }
        },
        orderBy: {
          created_at: 'asc'
        }
      });

      if (summaries.length < 2) {
        console.log(`Not enough summaries found for user ${subscriber.slack_user_id}`);
        continue;
      }

      // Find min and max total seconds
      let minSeconds = Infinity;
      let maxSeconds = 0;
      let minSummary;
      let maxSummary;

      summaries.forEach(summary => {
        const data = JSON.parse(summary.summary_data);
        const totalSeconds = data.projects?.reduce((total, project) => total + (project.total || 0), 0) || 0;
        if (totalSeconds < minSeconds) {
          minSeconds = totalSeconds;
          minSummary = data;
        }
        if (totalSeconds > maxSeconds) {
          maxSeconds = totalSeconds;
          maxSummary = data;
        }
      });

      const totalSeconds = maxSeconds - minSeconds;

      // Calculate project and language differences
      const projectStats = new Map();
      if (maxSummary?.projects && minSummary?.projects) {
        const minProjects = new Map(minSummary.projects.map(p => [p.key, p.total || 0]));
        const minLanguages = new Map(minSummary.languages?.map(l => [l.key, l.total || 0]) || []);
        
        // Group languages by project based on max summary
        const projectLanguages = new Map();
        maxSummary.languages?.forEach(lang => {
          const diff = (lang.total || 0) - (minLanguages.get(lang.key) || 0);
          if (diff > 0) {
            maxSummary.projects.forEach(proj => {
              if (!projectLanguages.has(proj.key)) {
                projectLanguages.set(proj.key, new Set());
              }
              projectLanguages.get(proj.key).add(lang.key);
            });
          }
        });

        // Calculate project times and associate languages
        maxSummary.projects.forEach(p => {
          const diff = (p.total || 0) - (minProjects.get(p.key) || 0);
          if (diff > 0) {
            projectStats.set(p.key, {
              seconds: diff,
              languages: Array.from(projectLanguages.get(p.key) || []).sort()
            });
          }
        });
      }

      // Only add users who have coded during this period
      if (totalSeconds > 0) {
        userStats.push({
          user_id: subscriber.slack_user_id,
          total_minutes: Math.floor(totalSeconds / 60),
          total_seconds: totalSeconds,
          projects: projectStats
        });
      }
    } catch (error) {
      console.error(`Error processing summaries for user ${subscriber.slack_user_id}:`, error);
    }
  }

  // Sort and get top 10
  const leaderboard = userStats
    .sort((a, b) => b.total_minutes - a.total_minutes)
    .slice(0, 10);

  if (leaderboard.length === 0) {
    return `No coding activity found for ${period === 'week' ? 'this week' : 'today'}.`;
  }

  // Format the leaderboard message
  const timeframe = period === 'week' ? 'This Week' : 'Today';
  let message = `🏆 *Coding Leaderboard - ${timeframe}*\n\n`;
  
  leaderboard.forEach((entry, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '▫️';
    const hours = Math.floor(entry.total_minutes / 60);
    const minutes = entry.total_minutes % 60;
    const timeStr = hours > 0 ? 
      `${hours}h ${minutes}m` : 
      `${minutes}m`;

    // Format project breakdown with languages
    const projectBreakdown = Array.from(entry.projects.entries())
      .sort((a, b) => b[1].seconds - a[1].seconds)
      .filter(([_, stats]) => Math.floor(stats.seconds / 60) > 0) // Filter out 0-minute projects
      .map(([project, stats]) => {
        const minutes = Math.floor(stats.seconds / 60);
        // Filter out unknown and AUTO_DETECTED languages
        const mainLang = stats.languages
          .filter(lang => !['unknown', 'AUTO_DETECTED', 'PLAIN_TEXT', 'Text'].includes(lang))
          .sort()[0] || '';
        
        return `${project} [${mainLang}]: ${minutes}m`;
      })
      .join(' + ');
    
    message += `${medal} <@${entry.user_id}>: ${timeStr} → ${projectBreakdown}\n`;
  });

  return message;
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

      console.log(`Checking coding milestones for user ${userId}`);
      await checkAndNotifyCodingMilestones(userId, summary);
      console.log(`Finished processing user ${userId}`);
    }
  }
  console.log('Finished processing all heartbeats');
}

// Create HTTP server for Slack commands
const server = Bun.serve({
  port,
  async fetch(req) {
    // Only accept POST requests to /slack/commands
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/slack/commands') {
      return new Response('Not Found', { status: 404 });
    }

    try {
      // Verify the request is from Slack and get form data
      const formData = await verifySlackRequest(req);
      
      // Handle the command
      return await handleSlashCommand(formData);
    } catch (error) {
      console.error('Error processing request:', error);
      return new Response(JSON.stringify({
        response_type: 'ephemeral',
        text: 'Sorry, there was an error processing your request.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
});

console.log(`Server listening on port ${server.port}`);

// Start heartbeat polling
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
