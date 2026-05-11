// Build script for @wago/db — skips tsc if drizzle-orm is not installed
try {
  require('drizzle-orm/sqlite-core');
} catch {
  console.log('skipping db build (no deps)');
  process.exit(0);
}

// Run tsc
const { execSync } = require('child_process');
execSync('npx tsc', { stdio: 'inherit' });
