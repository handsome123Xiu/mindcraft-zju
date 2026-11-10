import fs from 'node:fs';
import net from 'node:net';
import {createRequire} from 'node:module';
const port = Number(process.env.MINECRAFT_PORT || 25565);
try {
    const keys = fs.existsSync('keys.json') ? JSON.parse(fs.readFileSync('keys.json','utf8')) : {};
    const profile = JSON.parse(fs.readFileSync('andy.json','utf8'));
    if (!profile.model?.model || profile.model.model === 'YOUR_MODEL_ID' || !profile.model.url || profile.model.url.includes('.example')) throw new Error('Fill model and API base URL in andy.json first.');
    if (!keys.COURSE_API_KEY && !process.env.COURSE_API_KEY) throw new Error('COURSE_API_KEY is missing in keys.json');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LAN port.');
    const require = createRequire(new URL('../package.json', import.meta.url));
    const settings = (await import('../settings.js')).default;
    try {
        const mineflayerRequire = createRequire(require.resolve('mineflayer'));
        const Chunk = mineflayerRequire('prismarine-chunk')(settings.minecraft_version);
        new Chunk();
    } catch {
        throw new Error('Minecraft chunk dependency check failed. See package.json: prismarine-chunk must stay pinned to 1.39.0 for this installation.');
    }
    await new Promise((resolve, reject) => {
        const socket = net.createConnection({host: settings.host, port});
        socket.setTimeout(2500);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('timeout', () => { socket.destroy(); reject(new Error('LAN port timed out.')); });
        socket.once('error', () => reject(new Error(`Cannot connect to Minecraft at 127.0.0.1:${port}. Open your world to LAN first.`)));
    });
    console.log(`Local setup OK; Minecraft TCP port ${port} is open.`);
} catch(error) { console.error(error.message); process.exitCode = 1; }
