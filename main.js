import { startBuildingAgent } from './src/building/start.js';

try {
    await startBuildingAgent();
} catch (error) {
    console.error('[Build]', error.message);
    process.exitCode = 1;
}
