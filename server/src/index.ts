import { createApp, config } from './app.js';
import { migrate } from './migrate.js';
import { startScheduler } from './refdata/scheduler.js';
import { recoverInterrupted } from './ai/intake.js';
import { start as startQueue } from './tvinn/queue.js';

const applied = await migrate();
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
await recoverInterrupted();
await startQueue();
createApp().listen(config.port, () => console.log(`OdinAi is running on http://localhost:${config.port}`));
startScheduler();
