import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';

// Load environment variables from .env file
const envPath = process.env.ENV_PATH || '.env';
await import('dotenv').then(dotenv => dotenv.config({ path: envPath }));

// Initialize databases
const hackatime = new Pool({ connectionString: process.env.HACKATIME_DATABASE_URL });
const prisma = new PrismaClient();
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
  
  // Create signature base string
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
  
  // Compare signatures
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

  // Get API keys and summaries for all users
  const userStats = [];
  
  for (const subscriber of subscribers) {
    const apiKey = await getUserApiKey(subscriber.slack_user_id);
    if (!apiKey) {
      console.log(`No API key found for user ${subscriber.slack_user_id}`);
      continue;
    }

    try {
      const range = period === 'week' ? 'last_7_days' : 'day';
      console.log(apiKey)
      const response = await fetch(`https://waka.hackclub.com/api/v1/users/current/summaries?range=${range}`, {
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${Buffer.from(apiKey).toString('base64')}`
        }
      });
      
      if (!response.ok) {
        console.error(`API request failed for user ${subscriber.slack_user_id} with status ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      
      // Calculate total time and lines
      const totalSeconds = data.reduce((total, day) => total + (day.grand_total.total_seconds || 0), 0);
      const totalLines = data.reduce((total, day) => {
        return total + day.languages.reduce((langTotal, lang) => langTotal + (lang.total_lines || 0), 0);
      }, 0);

      userStats.push({
        user_id: subscriber.slack_user_id,
        total_minutes: Math.floor(totalSeconds / 60),
        lines: totalLines
      });
    } catch (error) {
      console.error(`Error fetching summary for user ${subscriber.slack_user_id}:`, error);
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
    
    message += `${medal} <@${entry.user_id}>: ${timeStr} (${entry.lines.toLocaleString()} lines)\n`;
  });

  return message;
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

// Create server
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

console.log(`Slack command server listening on port ${server.port}`); 