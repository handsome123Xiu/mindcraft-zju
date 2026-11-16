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

// Let the actual speaker mirror team activity to public game chat.
export function createTeamTranscriptViewer(bot) {
    const pending = [];
    let timer;
    function flush() {
        timer = undefined;
        if (!pending.length) return;
        const preview = pending.shift();
        if (bot._client?.state === 'play' && bot.entity && bot.entity.isValid !== false) {
            try { bot.chat(preview); } catch { /* Display must not affect the team run. */ }
        }
        timer = setTimeout(flush, 1100);
        timer.unref?.();
    }
    return {
        show(text) {
            // The bracketed prefix keeps model text in chat, even if the body starts with '/'.
            if (typeof text !== 'string' || !text.startsWith('[')) return;
            const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ');
            const preview = line.length > 180 ? line.slice(0, 163).replace(/[\uD800-\uDBFF]$/, '') + '…（完整见控制台日志）' : line;
            // Keep gameplay chat responsive. The console already holds the complete record.
            if (pending.length === 100) pending[pending.length - 1] = '[团队] 更多消息请查看控制台日志。';
            else pending.push(preview);
            if (!timer) flush();
        },
        close() { clearTimeout(timer); timer = undefined; pending.length = 0; }
    };
}
