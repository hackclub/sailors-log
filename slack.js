import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const port = process.env.PORT || 3000;

// Verify Slack requests are genuine using signing secret
async function verifySlackRequest(req) {
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  if (!slackSigningSecret) {
    throw new Error('SLACK_SIGNING_SECRET environment variable is not set');
  }

  const timestamp = req.headers.get('x-slack-request-timestamp');
  const signature = req.headers.get('x-slack-signature');
  
  // Check if request is older than 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (timestamp < fiveMinutesAgo) {
    throw new Error('Request is too old');
  }

  // Get raw body
  const body = await req.text();
  
  // Create signature base string
  const signatureBaseString = `v0:${timestamp}:${body}`;
  
  // Create signature
  const hmac = new Bun.CryptoHasher('sha256', slackSigningSecret);
  hmac.update(signatureBaseString);
  const mySignature = `v0=${hmac.digest('hex')}`;
  
  // Compare signatures
  if (mySignature !== signature) {
    throw new Error('Invalid signature');
  }

  return body;
}

async function handleSlashCommand(body) {
  const params = new URLSearchParams(body);
  const command = params.get('command');
  const text = params.get('text');
  const user_id = params.get('user_id');
  const channel_id = params.get('channel_id');

  // Verify this is our command
  if (command !== '/spyglass') {
    return new Response(JSON.stringify({ error: 'Invalid command' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Parse the command
  const action = text?.trim().toLowerCase();
  if (!['on', 'off'].includes(action)) {
    return new Response(JSON.stringify({
      response_type: 'ephemeral',
      text: 'Usage: /spyglass [on|off]'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Update or create preference
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
  } catch (error) {
    console.error('Error handling slash command:', error);
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
      // Verify the request is from Slack
      const body = await verifySlackRequest(req);
      
      // Handle the command
      return await handleSlashCommand(body);
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