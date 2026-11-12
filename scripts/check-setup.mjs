import net from 'node:net';
import { createRequire } from 'node:module';
import settings from '../settings.js';

const host = settings.host;
const port = Number(process.env.MINECRAFT_PORT ?? settings.port);
const require = createRequire(import.meta.url);

async function checkLan() {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid Minecraft port. Enter the number shown after opening the world to LAN.');
    }
    let mineflayerPath;
    try {
        mineflayerPath = require.resolve('mineflayer');
    } catch {
        throw new Error('Mineflayer is not installed in this project. Run npm ci in this folder with Node.js 22.');
    }
    try {
        const mineflayerRequire = createRequire(mineflayerPath);
        const Chunk = mineflayerRequire('prismarine-chunk')(settings.minecraft_version);
        new Chunk();
    } catch (error) {
        throw new Error('Minecraft ' + settings.minecraft_version + ' dependency check failed: ' + error.message);
    }
    await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        socket.setTimeout(2500);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('timeout', () => {
            socket.destroy();
            reject(new Error('Connection to ' + host + ':' + port + ' timed out.'));
        });
        socket.once('error', error => {
            reject(new Error('Cannot connect to ' + host + ':' + port + ' (' + error.code +
                '). Keep the world open to LAN and use its current port.'));
        });
    });
    console.log('Local setup OK; Minecraft TCP port ' + host + ':' + port + ' is open.');
}

try {
    await checkLan();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
