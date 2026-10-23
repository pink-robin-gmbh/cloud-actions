const fs = require('node:fs');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const MAX_MESSAGE_LENGTH = 11000;
const MAX_FAILURE_DETAIL_LENGTH = 320;
const MAX_FAILURE_NAME_LENGTH = 180;
const MAX_FAILURES_IN_BLOCKS = 43;

const CREDENTIAL_PATTERNS = [
    /\b[A-Z0-9_-]*(?:AUTHORIZATION|PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_-]*\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,\s"'<>]+)/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

class ReportError extends Error {}

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    alwaysCreateTextNode: true,
    trimValues: true,
});

function list(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function duration(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function getAttribute(node, name) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    return node[`@_${name}`];
}

function findCases(node, cases = []) {
    if (!node || typeof node !== 'object') return cases;
    if (Array.isArray(node)) {
        node.forEach((child) => findCases(child, cases));
        return cases;
    }
    for (const [key, value] of Object.entries(node)) {
        if (key === 'testcase') cases.push(...list(value));
        else if (key !== 'failure' && key !== 'error' && key !== 'skipped') findCases(value, cases);
    }
    return cases;
}

function scalarText(value) {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return scalarText(value[0]);
    if (!value || typeof value !== 'object') return '';
    return String(value['@_message'] || value['#text'] || '');
}

function failureDetail(testCase) {
    for (const kind of ['failure', 'error']) {
        if (Object.prototype.hasOwnProperty.call(testCase, kind)) {
            const detail = testCase[kind];
            const text = scalarText(detail);
            return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
        }
    }
    return '';
}

function parseReport(reportPath, elapsedSeconds) {
    if (!reportPath || !fs.existsSync(reportPath)) {
        throw new ReportError('Test report is missing');
    }

    let xml;
    try {
        xml = fs.readFileSync(reportPath, 'utf8');
    } catch {
        throw new ReportError('Test report is malformed or unreadable');
    }

    let document;
    try {
        const validation = XMLValidator.validate(xml);
        if (validation !== true) {
            throw new ReportError('Test report is malformed or unreadable');
        }
        document = parser.parse(xml);
    } catch {
        throw new ReportError('Test report is malformed or unreadable');
    }

    const rootName = Object.keys(document || {}).find((key) => ['testsuites', 'testsuite'].includes(key));
    if (!rootName) throw new ReportError('Test report has an unsupported XML structure');

    const root = document[rootName];
    const cases = findCases(root);
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures = [];

    for (const testCase of cases) {
        if (!testCase || typeof testCase !== 'object') continue;
        const hasFailure = Object.prototype.hasOwnProperty.call(testCase, 'failure');
        const hasError = Object.prototype.hasOwnProperty.call(testCase, 'error');
        const name = getAttribute(testCase, 'name') || getAttribute(testCase, 'id') || 'unnamed test';
        const className = getAttribute(testCase, 'classname');
        if (hasFailure || hasError) {
            failed += 1;
            failures.push({
                name: `${className ? `${className}: ` : ''}${name}`,
                detail: failureDetail(testCase),
            });
        } else if (Object.prototype.hasOwnProperty.call(testCase, 'skipped')) {
            skipped += 1;
        } else {
            passed += 1;
        }
    }

    let seconds = duration(getAttribute(root, 'time'));
    if (seconds === null) {
        let suiteDurations = [];
        if (rootName === 'testsuite') {
            suiteDurations = [duration(getAttribute(root, 'time'))];
        } else {
            suiteDurations = list(root.testsuite).map((suite) => duration(getAttribute(suite, 'time')));
        }
        const available = suiteDurations.filter((value) => value !== null);
        if (available.length) seconds = available.reduce((total, value) => total + value, 0);
    }
    if (seconds === null) {
        const caseDurations = cases.map((testCase) => duration(getAttribute(testCase, 'time')))
            .filter((value) => value !== null);
        if (caseDurations.length) seconds = caseDurations.reduce((total, value) => total + value, 0);
    }
    if (seconds === null && elapsedSeconds !== undefined && elapsedSeconds !== null) {
        const elapsed = Number(elapsedSeconds);
        if (Number.isFinite(elapsed) && elapsed >= 0) seconds = elapsed;
    }

    return {
        passed,
        failed,
        skipped,
        executed: passed + failed,
        failures,
        durationSeconds: seconds,
    };
}

function sanitizeText(value, secret = '') {
    let text = String(value || '');
    if (secret) text = text.split(secret).join('[redacted]');
    for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, '[redacted]');
    return text.replace(/\s+/g, ' ')
        .replace(/@/g, '[at]')
        .replace(/</g, '[lt]')
        .replace(/>/g, '[gt]')
        .replace(/\*/g, '[star]')
        .replace(/_/g, '[underscore]')
        .replace(/`/g, "'")
        .replace(/~/g, '-');
}

function sanitizeUrl(value, secret = '') {
    let text = String(value || '');
    if (secret) text = text.split(secret).join('[redacted]');
    for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, '[redacted]');
    return text.replace(/\s+/g, ' ').slice(0, 1500);
}

function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return 'unavailable';
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const remainder = total % 3600;
    const minutes = Math.floor(remainder / 60);
    const remainingSeconds = remainder % 60;
    if (hours) return `${hours}h ${minutes}m ${remainingSeconds}s`;
    if (minutes) return `${minutes}m ${remainingSeconds}s`;
    return `${remainingSeconds}s`;
}

function metadataLines(metadata, secret) {
    const lines = [
        `Workflow: ${sanitizeText(metadata.workflow, secret).slice(0, 300) || 'unknown'}`,
        `Branch: ${sanitizeText(metadata.branch, secret).slice(0, 300) || 'unknown'}`,
        `Commit: ${sanitizeText(metadata.commit, secret).slice(0, 40) || 'unknown'}`,
    ];
    if (metadata.eventName === 'workflow_dispatch') {
        lines.push('Manual run');
        const manualContext = sanitizeText(metadata.manualContext, secret).slice(0, 700);
        if (manualContext) lines.push(`Overrides: ${manualContext}`);
    }
    return lines;
}

function formatMessage(report, metadata, reportError, secret = '') {
    let outcome = sanitizeText(metadata.testOutcome, secret).toUpperCase() || 'UNKNOWN';
    if (report && report.failed) outcome = 'FAILURE';
    const workflow = sanitizeText(metadata.workflow, secret).slice(0, 300) || 'Test run';
    const lines = [`${outcome} - ${workflow}`, ...metadataLines(metadata, secret)];

    if (reportError) {
        lines.push(`Test report unavailable: ${sanitizeText(reportError, secret).slice(0, 400)}`);
    } else {
        lines.push(
            `Tests: ${report.executed} executed (${report.passed} passed, ${report.failed} failed); ${report.skipped} skipped`,
            `Test duration: ${formatDuration(report.durationSeconds)}`,
        );
    }

    const runUrl = sanitizeUrl(metadata.runUrl, secret);
    if (runUrl) lines.push(`Actions run: ${runUrl}`);
    const artifactUrl = sanitizeUrl(metadata.artifactUrl, secret);
    if (artifactUrl) lines.push(`Test artifact: ${artifactUrl}`);

    const failures = report ? report.failures : [];
    if (failures.length) lines.push('Failures:');
    const rows = failures.map((failure) => {
        const name = sanitizeText(failure.name, secret).slice(0, MAX_FAILURE_NAME_LENGTH) || 'unnamed test';
        const detail = sanitizeText(failure.detail, secret).slice(0, MAX_FAILURE_DETAIL_LENGTH);
        return `- ${name}${detail ? `: ${detail}` : ''}`;
    });

    const render = (selectedRows) => {
        const messageLines = [...lines, ...selectedRows];
        const omitted = failures.length - selectedRows.length;
        if (omitted) messageLines.push(`Omitted failure details: ${omitted}`);
        return messageLines.join('\n');
    };

    const selected = [];
    for (const row of rows) {
        const candidate = [...selected, row];
        if (render(candidate).length > MAX_MESSAGE_LENGTH) break;
        selected.push(row);
    }
    let message = render(selected);
    while (message.length > MAX_MESSAGE_LENGTH && selected.length) {
        selected.pop();
        message = render(selected);
    }
    return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}

function blockLink(value, secret) {
    const candidate = sanitizeUrl(value, secret);
    if (!candidate) return '';
    try {
        const url = new URL(candidate);
        if (url.protocol !== 'https:' || url.username || url.password) return '';
        return url.href.length <= 1500 ? url.href : '';
    } catch {
        return '';
    }
}

function formatBlocks(report, metadata, reportError, secret = '') {
    let outcome = sanitizeText(metadata.testOutcome, secret).toUpperCase() || 'UNKNOWN';
    if (report && report.failed) outcome = 'FAILURE';
    const workflow = sanitizeText(metadata.workflow, secret).slice(0, 300) || 'Test run';
    const emoji = outcome === 'SUCCESS' ? '✅' : outcome === 'FAILURE' ? '❌' : '⚪';
    const blocks = [{
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} ${outcome} · ${workflow}`.slice(0, 150), emoji: true },
    }];

    if (reportError) {
        blocks.push({
            type: 'section',
            text: {
                type: 'plain_text',
                text: `Test report unavailable: ${sanitizeText(reportError, secret).slice(0, 400)}`,
            },
        });
    } else {
        blocks.push({
            type: 'section',
            fields: [
                { type: 'plain_text', text: `Executed\n${report.executed}`, emoji: true },
                { type: 'plain_text', text: `Passed\n${report.passed}`, emoji: true },
                { type: 'plain_text', text: `Failed\n${report.failed}`, emoji: true },
                { type: 'plain_text', text: `Skipped\n${report.skipped}`, emoji: true },
                { type: 'plain_text', text: `Duration\n${formatDuration(report.durationSeconds)}`, emoji: true },
            ],
        });
    }

    const branch = sanitizeText(metadata.branch, secret).slice(0, 300) || 'unknown';
    const commit = sanitizeText(metadata.commit, secret).slice(0, 40) || 'unknown';
    const context = [{ type: 'plain_text', text: `Branch: ${branch} · Commit: ${commit}` }];
    if (metadata.eventName === 'workflow_dispatch') {
        context.push({ type: 'plain_text', text: 'Manual run' });
        const manualContext = sanitizeText(metadata.manualContext, secret).slice(0, 700);
        if (manualContext) context.push({ type: 'plain_text', text: `Overrides: ${manualContext}` });
    }
    blocks.push({ type: 'context', elements: context });

    const failures = report ? report.failures : [];
    if (failures.length) {
        blocks.push({ type: 'divider' });
        const more = failures.length > MAX_FAILURES_IN_BLOCKS
            ? ` (showing first ${MAX_FAILURES_IN_BLOCKS})`
            : '';
        blocks.push({
            type: 'section',
            text: { type: 'plain_text', text: `Failures (${failures.length})${more}` },
        });
        for (const failure of failures.slice(0, MAX_FAILURES_IN_BLOCKS)) {
            const name = sanitizeText(failure.name, secret).slice(0, MAX_FAILURE_NAME_LENGTH) || 'unnamed test';
            const detail = sanitizeText(failure.detail, secret).slice(0, MAX_FAILURE_DETAIL_LENGTH);
            blocks.push({
                type: 'section',
                text: { type: 'plain_text', text: `${name}${detail ? `\n${detail}` : ''}` },
            });
        }
    }

    const buttons = [];
    const runUrl = blockLink(metadata.runUrl, secret);
    const artifactUrl = blockLink(metadata.artifactUrl, secret);
    if (runUrl) {
        buttons.push({
            type: 'button',
            action_id: 'open_actions_run',
            text: { type: 'plain_text', text: 'Open workflow run', emoji: true },
            url: runUrl,
        });
    }
    if (artifactUrl) {
        buttons.push({
            type: 'button',
            action_id: 'open_test_artifact',
            text: { type: 'plain_text', text: 'Open test artifact', emoji: true },
            url: artifactUrl,
        });
    }
    if (buttons.length) blocks.push({ type: 'actions', elements: buttons });

    return blocks;
}

async function sendMessage(channel, token, message, blocks) {
    if (!channel) throw new Error('Slack channel ID is not configured');
    if (!token) throw new Error('Slack bot token is not configured');

    let response;
    try {
        response = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
                channel,
                text: message,
                mrkdwn: false,
                ...(blocks ? { blocks } : {}),
            }),
            signal: AbortSignal.timeout(20000),
        });
    } catch {
        throw new Error('Slack request could not be completed');
    }

    if (!response.ok) throw new Error(`Slack API returned HTTP status ${response.status}`);

    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error('Slack returned an invalid response');
    }
    if (!result || result.ok !== true) {
        const safeError = sanitizeText(result && result.error ? result.error : 'unspecified API error', token)
            .slice(0, 160);
        throw new Error(`Slack rejected the message: ${safeError}`);
    }
}

function writeWarning(message, token) {
    const safeMessage = sanitizeText(message, token);
    const workflowCommand = safeMessage.replace(/%/g, '%25');
    console.log(`::warning::${workflowCommand}`);
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;
    try {
        fs.appendFileSync(summaryPath, `## Slack test report warning\n\n${safeMessage}\n`, 'utf8');
    } catch {
        console.log('::warning::Could not write the Slack report warning to the step summary');
    }
}

async function main(environment = process.env) {
    let report;
    let reportError;
    try {
        report = parseReport(environment.REPORT_PATH, environment.TEST_DURATION_SECONDS);
    } catch (error) {
        if (!(error instanceof ReportError)) throw error;
        reportError = error.message;
    }

    const token = environment.SLACK_BOT_TOKEN || '';
    const metadata = {
        workflow: environment.WORKFLOW,
        branch: environment.BRANCH,
        commit: environment.COMMIT,
        eventName: environment.EVENT_NAME,
        manualContext: environment.MANUAL_CONTEXT,
        runUrl: environment.RUN_URL,
        artifactUrl: environment.ARTIFACT_URL,
        testOutcome: environment.TEST_OUTCOME,
    };
    const message = formatMessage(report, metadata, reportError, token);
    const blocks = formatBlocks(report, metadata, reportError, token);
    const errors = [];
    if (reportError) errors.push(reportError);
    try {
        await sendMessage(environment.SLACK_CHANNEL_ID || '', token, message, blocks);
    } catch (error) {
        errors.push(error.message);
    }

    if (errors.length) {
        writeWarning(errors.join('; '), token);
        return 1;
    }
    return 0;
}

module.exports = {
    MAX_MESSAGE_LENGTH,
    ReportError,
    formatMessage,
    formatBlocks,
    main,
    parseReport,
    sendMessage,
};

if (require.main === module) {
    main().then((result) => {
        process.exitCode = result;
    }).catch(() => {
        writeWarning('Unexpected error while generating the Slack test report', process.env.SLACK_BOT_TOKEN || '');
        process.exitCode = 1;
    });
}
