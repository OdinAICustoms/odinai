import { createApp, config } from './app.js';
import { migrate } from './migrate.js';
import { startScheduler } from './refdata/scheduler.js';
import { recoverInterrupted } from './ai/intake.js';
import { start as startQueue } from './tvinn/queue.js';
import { start as startFiken } from './invoicing/fiken.js';

const applied = await migrate();
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
await recoverInterrupted();
await startQueue();
await startFiken();
createApp().listen(config.port, () => console.log(`OdinAi is running on http://localhost:${config.port}`));
startScheduler();
