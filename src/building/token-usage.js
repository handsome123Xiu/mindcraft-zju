export function emptyTokenUsage() {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, reportedRequests: 0, unreportedRequests: 0 };
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;

export function addTokenUsage(totals, usage) {
    if (!isCount(usage?.input_tokens) || !isCount(usage?.output_tokens)) {
        totals.unreportedRequests++;
        return;
    }
    totals.inputTokens += usage.input_tokens;
    totals.outputTokens += usage.output_tokens;
    totals.totalTokens += isCount(usage.total_tokens) ? usage.total_tokens : usage.input_tokens + usage.output_tokens;
    totals.reportedRequests++;
}

export function restoreTokenUsage(usage, modelRequests) {
    const totals = usage ?? emptyTokenUsage();
    if (!isCount(modelRequests) || Object.keys(emptyTokenUsage()).some(key => !isCount(totals[key])) ||
        totals.reportedRequests + totals.unreportedRequests > modelRequests) {
        throw new Error('保存的 Token 统计无效');
    }
    // Older states and interrupted requests may have no corresponding usage report.
    totals.unreportedRequests = modelRequests - totals.reportedRequests;
    return totals;
}

export function formatTokenUsage(totals) {
    if (!totals.reportedRequests && totals.unreportedRequests) {
        return `Token：${totals.unreportedRequests} 次请求未返回用量，无法统计`;
    }
    const number = value => value.toLocaleString('en-US');
    return `Token${totals.unreportedRequests ? '（已知）' : ''}：输入 ${number(totals.inputTokens)}，` +
        `输出 ${number(totals.outputTokens)}，合计 ${number(totals.totalTokens)}` +
        (totals.unreportedRequests ? `；另有 ${totals.unreportedRequests} 次请求未返回用量` : '');
}
