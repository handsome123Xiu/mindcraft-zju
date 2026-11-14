import { CourseResponses } from './course_responses.js';
import tls from 'node:tls';

let systemCertificatesLoaded = false;

export class DeepSeekResponses extends CourseResponses {
    static prefix = 'deepseek_responses';
    constructor(modelName = 'deepseek-flash', url = 'https://api.deepseek.com', params) {
        // On Windows the network's trusted CA may exist only in the OS store.
        // Node 22.19+ can use that store while retaining normal TLS validation.
        if (!systemCertificatesLoaded && tls.getCACertificates && tls.setDefaultCACertificates) {
            tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
            systemCertificatesLoaded = true;
        }
        super(modelName, url, params, { keyName: 'DEEPSEEK_API_KEY', provider: 'DeepSeek' });
    }
}
