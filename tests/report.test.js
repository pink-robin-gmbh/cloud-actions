const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_MESSAGE_LENGTH,
    ReportError,
    formatBlocks,
    formatFailureBlocks,
    formatFailureDetails,
    formatFailureMessage,
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
    assert.equal(report.errors, 1);
    assert.equal(report.failures.length, 2);
    assert.deepEqual(report.failures.map(({ kind }) => kind), ['failure', 'error']);
    assert.match(report.failures[0].detail, /expected 400, got 500 — assertion detail/);
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
    assert.match(message, /Commit: 01234567/);
    assert.match(message, new RegExp(metadata.runUrl));
    assert.match(formatBlocks({
        passed: 5,
        failed: 0,
        skipped: 2,
        executed: 5,
        failures: [],
        durationSeconds: 62,
    }, metadata)[0].text.text, /✅ SUCCESS · Integration tests/);
});

test('formats a Block Kit summary with metrics and safe link buttons', () => {
    const report = {
        passed: 2,
        failed: 1,
        errors: 0,
        skipped: 1,
        executed: 3,
        failures: [{ name: 'test @here *notify*', detail: 'API_TOKEN=verysecret' }],
        durationSeconds: 62,
    };
    const blocks = formatBlocks(report, metadata, undefined, 'bot-secret');

    assert.equal(blocks[0].type, 'header');
    assert.match(blocks[0].text.text, /❌ FAILURE · Integration tests/);
    assert.deepEqual(
        blocks[1].fields.map((field) => field.text),
        ['*Passed*\n2', '*Skipped*\n1', '*Failures*\n1', '*Errors*\n0', '*Total tests*\n4', '*Duration*\n1m 2s'],
    );
    assert.equal(blocks[1].fields.every((field) => field.type === 'mrkdwn'), true);
    const failureBlocks = formatFailureBlocks(report.failures[0], 'bot-secret');
    assert.match(JSON.stringify(failureBlocks), /test \[at\]here \[star\]notify\[star\]/);
    assert.match(JSON.stringify(failureBlocks), /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(failureBlocks), /@here|verysecret/);
    const missingReason = formatBlocks({
        ...report,
        failures: [{ name: 'unknown test', detail: '' }],
    }, metadata);
    assert.doesNotMatch(JSON.stringify(missingReason), /Reason unavailable in xUnit report/);
    assert.match(
        JSON.stringify(formatFailureBlocks({ name: 'unknown test', detail: '' })),
        /Reason unavailable in xUnit report/,
    );
    assert.deepEqual(blocks.at(-1).elements.map((button) => button.text.text), [
        'Open workflow run',
    ]);
    assert.equal(blocks.at(-1).elements[0].url, metadata.runUrl);
    assert.equal(blocks.at(-1).type, 'actions');
});

test('formats individual failures with xUnit reason fields and UI error fallback', () => {
    const report = parseReport(path.join(fixturesPath, 'slack-report.xml'));
    const blocks = formatBlocks(report, metadata);
    const rendered = JSON.stringify(blocks);
    const failureBlocks = formatFailureBlocks(report.failures[0]);

    assert.deepEqual(
        [report.passed, report.failed, report.errors, report.skipped, report.executed + report.skipped],
        [14, 4, 0, 5, 23],
    );
    assert.equal(report.failures[0].detail, 'Did not match snapshot');
    assert.match(report.failures[0].values, /\+\s+\{/);
    assert.deepEqual(
        blocks[1].fields.map((field) => field.text),
        ['*Passed*\n14', '*Skipped*\n5', '*Failures*\n4', '*Errors*\n0', '*Total tests*\n23', '*Duration*\nunavailable'],
    );
    assert.doesNotMatch(rendered, /#4 integration/);
    assert.equal(failureBlocks.length, 1);
    const details = failureBlocks[0];
    assert.ok(details);
    assert.equal(details.title.text, 'FAIL · #4 integration › Users › getUsersOfGroup › /get users of group, no page and no page size');
    assert.equal(details.is_collapsible, true);
    assert.equal(details.default_collapsed, true);
    assert.ok(details.child_blocks.some((block) => block.text.text.includes('averageRating: null')));
    assert.match(JSON.stringify(details), /FAIL · #4 integration › Users › getUsersOfGroup/);
    assert.doesNotMatch(JSON.stringify(details), /\*FAIL|\*Did not match snapshot\*/);
    assert.match(formatFailureMessage(report.failures[0]), /^FAIL · #4 integration/);

    const uiReport = parseReport(path.join(fixturesPath, 'ui-report.xml'));
    const uiError = uiReport.failures.find(({ kind }) => kind === 'error');
    const uiBlocks = formatFailureBlocks(uiError);
    assert.equal(uiBlocks[0].type, 'container');
    assert.equal(uiBlocks[0].title.text, 'ERROR · ui.auth: unavailable auth flow');
    assert.match(JSON.stringify(uiBlocks), /browser timeout/);
    assert.doesNotMatch(JSON.stringify(uiBlocks), /\*ERROR|\*browser timeout\*/);
});

test('bounds Block Kit failure details and omits unsafe links', () => {
    const report = {
        passed: 0,
        failed: 80,
        skipped: 0,
        executed: 80,
        failures: Array.from({ length: 80 }, (_, index) => ({
            name: `test-${index}`,
            detail: 'failure detail',
        })),
        durationSeconds: 30,
    };
    const blocks = formatBlocks(report, { ...metadata, runUrl: 'javascript:alert(1)' });
    const oversizedUrlBlocks = formatBlocks(report, {
        ...metadata,
        runUrl: `https://example.com/${'ø'.repeat(800)}`,
    });
    const detailsBlocks = formatFailureDetails({
        failures: Array.from({ length: 80 }, (_, index) => ({
            name: `test-${index}`,
            detail: 'failure detail',
            values: 'x'.repeat(5000),
        })),
    });

    assert.ok(blocks.length <= 50);
    assert.equal(detailsBlocks.length, 1);
    assert.equal(detailsBlocks[0].title.text, 'Expand for failure details');
    assert.equal(detailsBlocks[0].width, 'full');
    assert.equal(detailsBlocks[0].is_collapsible, true);
    assert.equal(detailsBlocks[0].default_collapsed, true);
    assert.equal(detailsBlocks[0].child_blocks.length, 10);
    assert.ok(detailsBlocks[0].child_blocks.every((block) => block.text.text.length <= 3000));
    assert.match(detailsBlocks[0].child_blocks[0].text.text, /details truncated/);
    assert.match(detailsBlocks[0].child_blocks.at(-1).text.text, /71 more failures omitted/);
    assert.equal(blocks.filter((block) => block.type === 'container').length, 0);
    assert.doesNotMatch(JSON.stringify(blocks), /test-0/);
    assert.equal(blocks[2].type, 'context');
    assert.equal(oversizedUrlBlocks[2].type, 'context');
    assert.equal(blocks.some((block) => block.type === 'actions'), false);
    assert.equal(oversizedUrlBlocks.some((block) => block.type === 'actions'), false);
});

test('shows manual run without overrides or invented counts for unavailable reports', () => {
    const manual = {
        ...metadata,
        eventName: 'workflow_dispatch',
        manualContext: 'VersionCore=develop; SkipDeploy=true',
    };
    const message = formatMessage(null, manual, 'report missing');
    const blocks = formatBlocks(null, manual, 'report missing');

    assert.match(message, /Manual run/);
    assert.doesNotMatch(message, /Overrides:|VersionCore=develop|SkipDeploy=true/);
    assert.match(message, /Test report unavailable: report missing/);
    assert.doesNotMatch(message, /0 executed/);
    assert.match(JSON.stringify(blocks), /Manual run/);
    assert.doesNotMatch(JSON.stringify(blocks), /Overrides:|VersionCore=develop|SkipDeploy=true/);
    assert.match(blocks[0].text.text, /⚠️ REPORT UNAVAILABLE · Integration tests/);
    assert.equal(blocks[2].type, 'context');
    assert.equal(blocks[1].type, 'section');
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
    const message = formatFailureMessage(report.failures[0], 'bot-secret');

    assert.match(message, /^FAIL · test \[at\]here \[star\]notify\[star\]/);
    assert.doesNotMatch(message, /@here|\*notify\*|verysecret|xoxb-|correct horse battery staple/);
    assert.match(message, /\[redacted\]/);
    assert.match(message, /\[at\]here/);
});

test('keeps failure summaries short and preserves the run link', () => {
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
    assert.doesNotMatch(message, /test-0|failure detail/);
    assert.ok(message.includes(metadata.runUrl));
});

test('posts a Slack message with token only in the authorization header', async () => {
    await withMockFetch(async (url, options) => {
        assert.equal(url, 'https://slack.com/api/chat.postMessage');
        assert.equal(options.headers.Authorization, 'Bearer xoxb-secret-token');
        assert.equal(options.headers['Content-Type'], 'application/json; charset=utf-8');
        assert.equal(options.signal instanceof AbortSignal, true);
        const payload = JSON.parse(options.body);
        assert.doesNotMatch(options.body, /xoxb-secret-token/);
        assert.equal(payload.mrkdwn, false);
        assert.deepEqual(payload.blocks, [{ type: 'header' }]);
        return { ok: true, json: async () => ({ ok: true, ts: '123.456' }) };
    }, async () => {
        assert.equal(
            await sendMessage('C123', 'xoxb-secret-token', 'Test summary', [{ type: 'header' }]),
            '123.456',
        );
    });
});

test('retries Slack rate limits using Retry-After', async () => {
    let attempts = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        await withMockFetch(async () => {
            attempts += 1;
            if (attempts === 1) {
                return {
                    ok: false,
                    status: 429,
                    headers: { get: () => '0' },
                };
            }
            return { ok: true, json: async () => ({ ok: true, ts: '123.456' }) };
        }, async () => {
            assert.equal(await sendMessage('C123', 'token', 'Test summary'), '123.456');
        });
    } finally {
        Math.random = originalRandom;
    }
    assert.equal(attempts, 2);
});

test('reports rate limits without a usable Retry-After header', async () => {
    await withMockFetch(async () => ({
        ok: false,
        status: 429,
        headers: { get: () => null },
    }), async () => {
            await assert.rejects(
                sendMessage('C123', 'token', 'Test summary'),
                /valid Retry-After header/,
            );
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
            messages.push(JSON.parse(options.body));
            return { ok: true, json: async () => ({ ok: true, ts: '123.456' }) };
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
    assert.match(messages[0].text, /Test report unavailable: Test report is missing/);
    assert.match(JSON.stringify(messages[0].blocks), /Test report unavailable: Test report is missing/);
    assert.doesNotMatch(messages[0].text, /0 executed/);
    assert.ok(logs.some((line) => line.includes('::warning::Test report is missing')));
    assert.ok(logs.every((line) => !line.includes('bot-secret')));
});

test('posts the overview and individual tests as separate channel messages', async () => {
    const messages = [];
    let timestamp = 0;
    await withMockFetch(async (_url, options) => {
        messages.push(JSON.parse(options.body));
        timestamp += 1;
        return { ok: true, json: async () => ({ ok: true, ts: `123.45${timestamp}` }) };
    }, async () => {
        const result = await main({
            REPORT_PATH: path.join(fixturesPath, 'slack-report.xml'),
            TEST_OUTCOME: 'failure',
            WORKFLOW: 'Integration tests',
            BRANCH: 'main',
            COMMIT: 'abc123',
            EVENT_NAME: 'push',
            RUN_URL: 'https://github.com/example/repo/actions/runs/42',
            SLACK_CHANNEL_ID: 'C123',
            SLACK_BOT_TOKEN: 'bot-secret',
        });
        assert.equal(result, 0);
    });

    const failures = parseReport(path.join(fixturesPath, 'slack-report.xml')).failures;
    assert.equal(messages.length, failures.length + 1);
    assert.match(messages[0].blocks[0].text.text, /FAILURE · Integration tests/);
    assert.match(messages[0].text, /4 failed/);
    assert.doesNotMatch(JSON.stringify(messages[0].blocks), /#4 integration/);
    assert.ok(messages.every((message) => message.thread_ts === undefined));
    assert.deepEqual(
        messages.slice(1).map((message) => message.text.split('\n')[0]),
        failures.map(({ name, kind }) => `${kind === 'error' ? 'ERROR' : 'FAIL'} · ${name}`),
    );
    assert.ok(messages.slice(1).every((message) => message.blocks.some((block) => block.type === 'container')));
    const failureDetails = messages[1].blocks.find((block) => block.type === 'container');
    assert.ok(failureDetails);
    assert.equal(failureDetails.title.text, 'FAIL · #4 integration › Users › getUsersOfGroup › /get users of group, no page and no page size');
    assert.equal(failureDetails.is_collapsible && failureDetails.default_collapsed, true);
    assert.ok(failureDetails.child_blocks.length <= 10);
    const renderedDetails = JSON.stringify(failureDetails.child_blocks);
    assert.match(renderedDetails, /#4 integration/);
    assert.match(renderedDetails, /Did not match snapshot/);
    assert.doesNotMatch(renderedDetails, /\*FAIL|\*Did not match snapshot\*/);
    assert.match(renderedDetails, /averageRating: null/);
    assert.match(messages[2].text, /#20 integration/);
    assert.match(messages[2].text, /order_complete/);
    assert.equal(messages[0].blocks.at(-1).type, 'actions');
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
