// Use whisper(), whose command and recipient are controlled by the application.
// Model text is always the message body, including text starting with '/'.
export function createMessageSender(bot, { log = console.log } = {}) {
    return async function sendMessage(recipient, text, signal) {
        signal?.throwIfAborted();
        if (!/^[a-zA-Z0-9_]{1,16}$/.test(recipient ?? '')) throw new Error('无效的消息接收者');
        if (typeof text !== 'string' || !text.trim() || text.length > 1000 || /[\u0000-\u001f\u007f]/.test(text)) {
            throw new Error('消息需为 1–1000 个字符，且不能包含控制字符');
        }
        if (!bot.entity || bot.entity.isValid === false || bot._client?.state !== 'play') throw new Error('机器人当前未连接，无法发送消息');
        const chars = Array.from(text.trim());
        let parts = 0;
        while (chars.length) {
            signal?.throwIfAborted();
            let part = '';
            while (chars.length && part.length + chars[0].length <= 120) part += chars.shift();
            if (bot.whisper(recipient, part) === false) throw new Error('消息发送被拒绝');
            parts++;
            log('[Message -> ' + recipient + ']', part);
        }
        // Mineflayer queues chat packets; this is not a server/read receipt.
        return { status: 'sent', recipient, parts, delivery: 'queued' };
    };
}
