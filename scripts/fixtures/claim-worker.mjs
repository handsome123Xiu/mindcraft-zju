import { claimPart } from '../../src/building/team-state.js';
process.send('ready');
process.once('message', async () => {
    try { process.send(await claimPart(process.argv[2], process.argv[3], 'part-1')); }
    catch (error) { process.send({ status: 'error', message: error.message }); }
    finally { process.disconnect(); }
});
