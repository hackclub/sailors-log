const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({
  connectionString: process.env.HACKATIME_DATABASE_URL,
});

const prisma = new PrismaClient();

async function getRecentHeartbeats() {
  try {
    console.log('Starting heartbeat fetch process...');
    
    // Get the last stored heartbeat timestamp
    const lastHeartbeat = await prisma.lastHeartbeat.findFirst();
    console.log('Last stored heartbeat:', lastHeartbeat ? new Date(lastHeartbeat.heartbeatCreatedAt).toISOString() : 'None found');
    
    const client = await pool.connect();
    console.log('Connected to Hackatime database');
    
    let query;
    let params = [];

    if (lastHeartbeat) {
      console.log('Using last heartbeat timestamp as reference');
      query = `
        SELECT *
        FROM heartbeats
        WHERE created_at > $1
        ORDER BY created_at DESC
      `;
      params = [lastHeartbeat.heartbeatCreatedAt];
    } else {
      console.log('No previous heartbeat found, fetching last 5 minutes');
      query = `
        SELECT *
        FROM heartbeats
        WHERE created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY created_at DESC
      `;
    }

    console.log('Executing query:', query.replace(/\s+/g, ' ').trim());
    if (params.length) {
      console.log('Query parameters:', params);
    }

    const result = await client.query(query, params);
    console.log(`Found ${result.rows.length} heartbeats`);
    
    // Store the most recent heartbeat timestamp if we got any results
    if (result.rows.length > 0) {
      const mostRecentHeartbeat = result.rows[0].created_at;
      console.log('Most recent heartbeat:', new Date(mostRecentHeartbeat).toISOString());
      
      console.log('Updating LastHeartbeat record...');
      await prisma.lastHeartbeat.upsert({
        where: { id: 1 },
        update: { heartbeatCreatedAt: mostRecentHeartbeat },
        create: { 
          id: 1,
          heartbeatCreatedAt: mostRecentHeartbeat
        }
      });
      console.log('LastHeartbeat record updated successfully');
    } else {
      console.log('No new heartbeats found');
    }
    
    client.release();
    console.log('Database connection released');
    
    return result.rows;
  } catch (err) {
    console.error('Error in getRecentHeartbeats:', err);
    console.error('Error details:', {
      name: err.name,
      message: err.message,
      stack: err.stack
    });
    throw err;
  }
}

// Example usage with proper cleanup:
async function main() {
  let exitCode = 0;
  try {
    const heartbeats = await getRecentHeartbeats();
    console.log('Execution completed successfully');
    console.log(`Processed ${heartbeats.length} heartbeats`);
  } catch (err) {
    console.error('Failed to get heartbeats:', err);
    exitCode = 1;
  } finally {
    console.log('Cleaning up connections...');
    try {
      await Promise.all([
        prisma.$disconnect(),
        pool.end()
      ]);
      console.log('Connections closed');
    } catch (err) {
      console.error('Error during cleanup:', err);
      exitCode = 1;
    }
    process.exit(exitCode);
  }
}

main();
