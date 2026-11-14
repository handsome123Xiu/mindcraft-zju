import { CourseResponses } from '../models/course_responses.js';
import { DeepSeekResponses } from '../models/deepseek_responses.js';

export const BUILDING_MODEL_APIS = ['course_responses', 'deepseek_responses'];

// Startup and diagnostics use the same lazy adapter, including its capabilities.
// Reading metadata must not create a client or require credentials.
export function createLazyBuildingModel(config, factory = createBuildingModel) {
    let adapter;
    return {
        modelName: config?.model,
        provider: config?.api === 'deepseek_responses' ? 'DeepSeek' : 'Course',
        decisionProtocol: config?.api === 'deepseek_responses' ? 'native_functions' : 'json_action',
        async sendRequest(...args) {
            adapter ??= factory(config);
            return adapter.sendRequest(...args);
        }
    };
}

export function createBuildingModel(config) {
    if (!BUILDING_MODEL_APIS.includes(config?.api) || !config.model) throw new Error('建筑 Agent 需要 course_responses 或 deepseek_responses 模型配置');
    const Adapter = config.api === 'deepseek_responses' ? DeepSeekResponses : CourseResponses;
    return new Adapter(config.model, config.url, {
        ...config.params, max_output_tokens: Math.min(config.params?.max_output_tokens ?? 4096, 8192)
    });
}
