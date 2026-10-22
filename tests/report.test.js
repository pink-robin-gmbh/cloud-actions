const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_MESSAGE_LENGTH,
    ReportError,
    formatMessage,
    main,
    parseReport,
    sendMessage,
} = require('../.github/actions/test-run-report/report');

const fixturesPath = path.join(__dirname, 'fixtures');
const metadata = {
    workflow: 'Integration tests',
    branch: 'feature/report',
    commit: '0123456789abcdef',
    eventName: 'push',
    runUrl: 'https://github.com/example/my_repo/actions/runs/42',
    testOutcome: 'success',
};

function temporaryReport(xml) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-report-'));
    const reportPath = path.join(directory, 'report.xml');
    fs.writeFileSync(reportPath, xml);
    return {
        reportPath,
        cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
}

async function withMockFetch(mock, callback) {
    const originalFetch = global.fetch;
    global.fetch = mock;
    try {
        await callback();
    } finally {
        global.fetch = originalFetch;
    }
}

test('normalizes integration testsuites by case without aggregate double counting', () => {
    const report = parseReport(path.join(fixturesPath, 'integration-report.xml'));

    assert.deepEqual(
        [report.passed, report.failed, report.skipped, report.executed],
        [1, 2, 1, 3],
    );
    assert.equal(report.failures.length, 2);
    assert.equal(report.durationSeconds, null);
});

test('normalizes a single UI testsuite root', () => {
    const report = parseReport(path.join(fixturesPath, 'ui-report.xml'));

    assert.deepEqual(
        [report.passed, report.failed, report.skipped, report.executed],
        [1, 2, 1, 3],
    );
    assert.equal(report.durationSeconds, 12.5);
});

test('uses child-suite, case, and elapsed durations in order', () => {
    const suites = temporaryReport(
        '<testsuites><testsuite name="one" time="1.5"><testcase name="one"/></testsuite>'
        + '<testsuite name="two" time="2.5"><testcase name="two"/></testsuite></testsuites>',
    );
    const cases = temporaryReport(
        '<testsuite><testcase name="one" time="1.5"/><testcase name="two" time="2"/></testsuite>',
    );
    const zeroDuration = temporaryReport('<testsuite time="0"><testcase name="fast"/></testsuite>');
    const noTiming = temporaryReport('<testsuites><testsuite><testcase name="one"/></testsuite></testsuites>');
    try {
        assert.equal(parseReport(suites.reportPath, 99).durationSeconds, 4);
        assert.equal(parseReport(cases.reportPath, 99).durationSeconds, 3.5);
        assert.equal(parseReport(zeroDuration.reportPath).durationSeconds, 0);
        assert.equal(parseReport(noTiming.reportPath, 37).durationSeconds, 37);
        assert.equal(parseReport(noTiming.reportPath, 0).durationSeconds, 0);
    } finally {
        suites.cleanup();
        cases.cleanup();
        zeroDuration.cleanup();
        noTiming.cleanup();
    }
});

test('counts empty testcase elements as passing cases', () => {
    const report = temporaryReport('<testsuite><testcase/></testsuite>');
    try {
        const summary = parseReport(report.reportPath);
        assert.deepEqual([summary.passed, summary.failed, summary.skipped], [1, 0, 0]);
    } finally {
        report.cleanup();
    }
});

test('rejects missing, malformed, and unsupported reports', () => {
    assert.throws(() => parseReport('missing-report.xml'), ReportError);
    const malformed = temporaryReport('<testsuite>');
    const unsupported = temporaryReport('<report><testcase name="test"/></report>');
    try {
        assert.throws(() => parseReport(malformed.reportPath), /malformed/);
        assert.throws(() => parseReport(unsupported.reportPath), /unsupported/);
    } finally {
        malformed.cleanup();
        unsupported.cleanup();
    }
});

test('formats a compact success summary with duration and run link', () => {
    const report = {
        passed: 5,
        failed: 0,
        skipped: 2,
        executed: 5,
        failures: [],
        durationSeconds: 62,
    };
    const message = formatMessage(report, metadata);

    assert.match(message, /SUCCESS - Integration tests/);
    assert.match(message, /5 executed \(5 passed, 0 failed\); 2 skipped/);
    assert.match(message, /Test duration: 1m 2s/);
    assert.match(message, new RegExp(metadata.runUrl));
});

test('includes manual run overrides without inventing counts for unavailable reports', () => {
    const manual = {
        ...metadata,
        eventName: 'workflow_dispatch',
        manualContext: 'VersionCore=develop; SkipDeploy=true',
    };
    const message = formatMessage(null, manual, 'report missing');

    assert.match(message, /Manual run/);
    assert.match(message, /VersionCore=develop; SkipDeploy=true/);
    assert.match(message, /Test report unavailable: report missing/);
    assert.doesNotMatch(message, /0 executed/);
});

test('sanitizes mentions, formatting, and credential-like failure details', () => {
    const report = {
        passed: 0,
        failed: 1,
        skipped: 0,
        executed: 1,
        durationSeconds: 1,
        failures: [{
            name: 'test @here *notify*',
            detail: 'API_TOKEN=verysecret xoxb-1234567890-abcdefghijk PASSWORD="correct horse battery staple"',
        }],
    };
    const message = formatMessage(report, metadata, undefined, 'bot-secret');

    assert.match(message, /FAILURE - Integration tests/);
    assert.doesNotMatch(message, /@here|\*notify\*|verysecret|xoxb-|correct horse battery staple/);
    assert.match(message, /\[redacted\]/);
    assert.match(message, /\[at\]here/);
});

test('bounds failure output and preserves omitted count and run link', () => {
    const report = {
        passed: 0,
        failed: 80,
        skipped: 0,
        executed: 80,
        durationSeconds: 30,
        failures: Array.from({ length: 80 }, (_, index) => ({
            name: `test-${index}`,
            detail: 'failure detail '.repeat(50),
        })),
    };
    const message = formatMessage(report, metadata);

    assert.ok(message.length <= MAX_MESSAGE_LENGTH);
    assert.match(message, /Omitted failure details:/);
    assert.ok(message.includes(metadata.runUrl));
});

test('posts a Slack message with token only in the authorization header', async () => {
    await withMockFetch(async (url, options) => {
        assert.equal(url, 'https://slack.com/api/chat.postMessage');
        assert.equal(options.headers.Authorization, 'Bearer xoxb-secret-token');
        assert.equal(options.headers['Content-Type'], 'application/json; charset=utf-8');
        assert.equal(options.signal instanceof AbortSignal, true);
        assert.doesNotMatch(options.body, /xoxb-secret-token/);
        assert.match(options.body, /"mrkdwn":false/);
        return { ok: true, json: async () => ({ ok: true }) };
    }, async () => {
        await sendMessage('C123', 'xoxb-secret-token', 'Test summary');
    });
});

test('reports Slack API and network errors without exposing credentials or response data', async () => {
    await withMockFetch(async () => ({
        ok: true,
        json: async () => ({ ok: false, error: 'channel_not_found' }),
    }), async () => {
        await assert.rejects(
            sendMessage('C123', 'xoxb-secret-token', 'Test summary'),
            /channel\[underscore\]not\[underscore\]found/,
        );
    });

    await withMockFetch(async () => {
        throw new Error('private response detail');
    }, async () => {
        await assert.rejects(sendMessage('C123', 'token', 'Test summary'), /request could not be completed/);
    });
});

test('reports missing Slack configuration', async () => {
    await assert.rejects(sendMessage('', 'token', 'Test summary'), /channel ID is not configured/);
    await assert.rejects(sendMessage('C123', '', 'Test summary'), /bot token is not configured/);
});

test('posts an unavailable-report warning without fabricated counts', async () => {
    const messages = [];
    const logs = [];
    const originalLog = console.log;
    console.log = (message) => logs.push(message);
    try {
        await withMockFetch(async (_url, options) => {
            messages.push(JSON.parse(options.body).text);
            return { ok: true, json: async () => ({ ok: true }) };
        }, async () => {
            const result = await main({
                REPORT_PATH: 'missing-report.xml',
                TEST_OUTCOME: 'failure',
                WORKFLOW: 'Integration tests',
                BRANCH: 'main',
                COMMIT: 'abc123',
                EVENT_NAME: 'push',
                RUN_URL: 'https://github.com/example/repo/actions/runs/42',
                SLACK_CHANNEL_ID: 'C123',
                SLACK_BOT_TOKEN: 'bot-secret',
            });
            assert.equal(result, 1);
        });
    } finally {
        console.log = originalLog;
    }
    assert.match(messages[0], /Test report unavailable: Test report is missing/);
    assert.doesNotMatch(messages[0], /0 executed/);
    assert.ok(logs.some((line) => line.includes('::warning::Test report is missing')));
    assert.ok(logs.every((line) => !line.includes('bot-secret')));
});

test('writes a sanitized warning when Slack rejects a valid report', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-report-summary-'));
    const summaryPath = path.join(directory, 'summary.md');
    const originalSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    const logs = [];
    const originalLog = console.log;
    let summary;
    console.log = (message) => logs.push(message);

    try {
        await withMockFetch(async () => ({
            ok: true,
            json: async () => ({ ok: false, error: 'not_authed' }),
        }), async () => {
            const result = await main({
                REPORT_PATH: path.join(fixturesPath, 'ui-report.xml'),
                TEST_OUTCOME: 'success',
                WORKFLOW: 'UI tests',
                BRANCH: 'main',
                COMMIT: 'abc123',
                EVENT_NAME: 'push',
                RUN_URL: 'https://github.com/example/repo/actions/runs/42',
                SLACK_CHANNEL_ID: 'C123',
                SLACK_BOT_TOKEN: 'bot-secret',
            });
            assert.equal(result, 1);
        });
        summary = fs.readFileSync(summaryPath, 'utf8');
    } finally {
        console.log = originalLog;
        if (originalSummaryPath === undefined) delete process.env.GITHUB_STEP_SUMMARY;
        else process.env.GITHUB_STEP_SUMMARY = originalSummaryPath;
        fs.rmSync(directory, { recursive: true, force: true });
    }

    assert.match(summary, /Slack test report warning/);
    assert.match(summary, /not\[underscore\]authed/);
    assert.doesNotMatch(summary, /bot-secret/);
    assert.ok(logs.every((line) => !line.includes('bot-secret')));
});
