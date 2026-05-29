const { drizzle } = require('drizzle-orm/libsql');
const { migrate } = require('drizzle-orm/libsql/migrator');
const { createClient } = require('@libsql/client');
const path = require('path');

async function runMigrations() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    console.error('TURSO_DATABASE_URL is required');
    process.exit(1);
  }

  console.log('Running migrations against Turso DB...');

  const client = createClient({ url, authToken });
  const db = drizzle(client);

  await migrate(db, {
    migrationsFolder: path.join(__dirname, '..', 'drizzle'),
  });

  console.log('Migrations complete');
  client.close();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
