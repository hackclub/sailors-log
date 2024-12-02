import { prisma, getUserApiKey } from './db.js';

const port = process.env.PORT || 3000;

async function getLeaderboard(channel_id, period = 'day', limit = 10) {
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

  // Sort and get top N users
  const leaderboard = userStats
    .sort((a, b) => b.total_minutes - a.total_minutes)
    .slice(0, limit === 'all' ? undefined : limit);

  if (leaderboard.length === 0) {
    return `No coding activity found for ${period === 'week' ? 'this week' : 'today'}.`;
  }

  // Format the leaderboard message
  const timeframe = period === 'week' ? 'This Week' : 'Today';
  let message = `⛵ *Sailor's Log - ${timeframe}*\n\n`;
  
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

async function handleSlashCommand(formData) {
  // Get command parameters from FormData
  const command = formData.get('command');
  const text = formData.get('text');
  const user_id = formData.get('user_id');
  const channel_id = formData.get('channel_id');

  console.log('Received command:', { command, text, user_id, channel_id });

  // Verify this is our command
  if (command !== '/sailorslog') {
    return new Response(JSON.stringify({ error: 'Invalid command' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Parse the command
  const args = text?.trim().toLowerCase().split(/\s+/) || [];
  const action = args[0];

  // Handle empty command
  if (!action) {
    return new Response(JSON.stringify({
      response_type: 'ephemeral',
      text: 'Welcome to Sailor\'s Log! Usage:\n' +
           '• `/sailorslog on` - Enable notifications\n' +
           '• `/sailorslog off` - Disable notifications\n' +
           '• `/sailorslog status` - Check notification status\n' +
           '• `/sailorslog leaderboard [day|week] [N|all]` - Show coding leaderboard\n' +
           '  Examples:\n' +
           '  • `/sailorslog leaderboard` - Show today\'s top 10\n' +
           '  • `/sailorslog leaderboard week` - Show this week\'s top 10\n' +
           '  • `/sailorslog leaderboard day 100` - Show today\'s top 100\n' +
           '  • `/sailorslog leaderboard week all` - Show everyone this week'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Handle leaderboard command
    if (action === 'leaderboard') {
      console.log('Processing leaderboard command:', args);
      let period = 'day';
      let limit = 10;

      // Check for period argument
      if (args[1] === 'week') {
        period = 'week';
      }

      // Check for limit argument
      if (args.length >= 2 && args[args.length - 1] !== 'week' && args[args.length - 1] !== 'day') {
        const lastArg = args[args.length - 1];
        if (lastArg === 'all') {
          limit = 'all';
        } else {
          const parsedLimit = parseInt(lastArg, 10);
          if (!isNaN(parsedLimit) && parsedLimit > 0) {
            limit = parsedLimit;
          }
        }
      }

      console.log('Fetching leaderboard for period:', period, 'with limit:', limit);
      const message = await getLeaderboard(channel_id, period, limit);
      
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

      // Send a channel message when notifications are enabled
      const response = {
        response_type: 'ephemeral',
        text: `✅ Coding notifications have been turned ${action} in this channel.`
      };

      if (enabled) {
        response.response_type = 'in_channel';
        response.text = `<@${user_id}> ran \`/sailorslog on\` to turn on High Seas notifications in this channel. Every time they code an hour on a project, a short message celebrating will be posted to this channel. They will also show on \`/sailorslog leaderboard\`.`;
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // If we get here, the command is unknown
    return new Response(JSON.stringify({
      response_type: 'ephemeral',
      text: 'Welcome to Sailor\'s Log! Usage:\n' +
           '• `/sailorslog on` - Enable notifications\n' +
           '• `/sailorslog off` - Disable notifications\n' +
           '• `/sailorslog status` - Check notification status\n' +
           '• `/sailorslog leaderboard [day|week] [N|all]` - Show coding leaderboard\n' +
           '  Examples:\n' +
           '  • `/sailorslog leaderboard` - Show today\'s top 10\n' +
           '  • `/sailorslog leaderboard week` - Show this week\'s top 10\n' +
           '  • `/sailorslog leaderboard day 100` - Show today\'s top 100\n' +
           '  • `/sailorslog leaderboard week all` - Show everyone this week'
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

export default server; 