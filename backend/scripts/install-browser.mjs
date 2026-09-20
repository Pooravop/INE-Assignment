// Installs Chromium for Playwright unless told not to (Docker image ships it already).
import { spawnSync } from 'node:child_process';
if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') process.exit(0);
const r = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 0);
