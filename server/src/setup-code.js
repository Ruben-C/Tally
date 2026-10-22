// Mint a one-time passkey setup link. Run on the host:
//   docker compose exec -T tally node src/setup-code.js [--hours N] [--reset]
// Default lifetime is 15 minutes (max 48 h). Minting a new link voids the previous one.
// --reset wipes all passkeys and sessions first (lost-device recovery); restart the container after.
import './config.js';
const { mintSetupCode, ORIGIN, SETUP_CODE_TTL_MS, SETUP_CODE_MAX_TTL_MS } = await import('./auth.js');

const reset = process.argv.includes('--reset');
const i = process.argv.indexOf('--hours');
const ttlMs = Math.min(Math.max(i > 0 ? Number(process.argv[i + 1]) * 3600e3 || SETUP_CODE_TTL_MS : SETUP_CODE_TTL_MS, 60e3), SETUP_CODE_MAX_TTL_MS);
const code = mintSetupCode({ reset, ttlMs });
console.log(`${ORIGIN}/setup#code=${code}`);
console.error(`single use, valid for ${Math.round(ttlMs / 60e3)} minutes${reset ? '; passkeys and sessions wiped, restart the container' : ''}`);
process.exit(0);
