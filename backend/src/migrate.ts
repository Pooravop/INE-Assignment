import { getDb, migrate } from './db.js';
import { log } from './log.js';

const db = await getDb();
await migrate(db);
log.info('schema applied');
await db.close();
