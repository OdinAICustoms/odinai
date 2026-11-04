import { createApp, config } from './app.js';
import { migrate } from './migrate.js';
import { startScheduler } from './refdata/scheduler.js';

const applied = await migrate();
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
createApp().listen(config.port, () => console.log(`OdinAi is running on http://localhost:${config.port}`));
startScheduler();
