'use strict';

// Runs with mocha (npm run test:js) and with the Node test runner: node --test test/testReceiveQueue.js
const assert = require('node:assert/strict');
const { describe, it, afterEach } = typeof global.describe === 'function' ? global : require('node:test');

const ReceiveQueue = require('../lib/tools/ReceiveQueue');
const { TestEnv, radioFrame, sleep } = require('./lib/harness');

/** mocha: more time than the default 2 s for these end-to-end tests (no-op with node --test) */
function allowTime(ctx) {
	if (ctx && typeof ctx.timeout === 'function') {
		ctx.timeout(10000);
	}
}

function recordingLog() {
	const log = { warn: [], error: [] };
	return {
		log,
		logger: { warn: (m) => log.warn.push(m), error: (m) => log.error.push(m) },
	};
}

describe('ReceiveQueue', () => {
	it('runs packets strictly one after another, in order', async () => {
		const { logger } = recordingLog();
		const events = [];
		const q = new ReceiveQueue(
			async (data) => {
				events.push(`start ${data}`);
				await sleep(data === 'a' ? 30 : data === 'b' ? 1 : 10);
				events.push(`end ${data}`);
			},
			{ log: logger },
		);
		q.push('a');
		q.push('b');
		q.push('c');
		assert.equal(q.pending, 3);
		await q.drain();
		assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
		assert.equal(q.pending, 0);
	});

	it('logs a failing packet and continues with the next one', async () => {
		const { log, logger } = recordingLog();
		const done = [];
		const q = new ReceiveQueue(
			async (data) => {
				if (data === 'bad') {
					throw new Error('broken telegram');
				}
				done.push(data);
			},
			{ log: logger },
		);
		q.push('ok1');
		q.push('bad');
		q.push('ok2');
		await q.drain();
		assert.deepEqual(done, ['ok1', 'ok2']);
		assert.equal(log.error.length, 1);
		assert.match(log.error[0], /broken telegram/);
	});

	it('leaves a hanging packet behind after the timeout', async () => {
		const { log, logger } = recordingLog();
		const done = [];
		const q = new ReceiveQueue(
			async (data) => {
				if (data === 'hang') {
					await sleep(200);
				}
				done.push(data);
			},
			{ log: logger, timeoutMs: 30 },
		);
		q.push('hang');
		q.push('next');
		await q.drain();
		assert.deepEqual(done, ['next']);
		assert.equal(log.warn.length, 1);
		assert.match(log.warn[0], /took longer than/);
		await sleep(220); // the hanging one finishes later without side effects on the queue
		assert.deepEqual(done, ['next', 'hang']);
	});

	it('warns once when many packets are waiting', async () => {
		const { log, logger } = recordingLog();
		const q = new ReceiveQueue(() => sleep(1), { log: logger, warnPending: 5 });
		for (let i = 0; i < 12; i++) {
			q.push(String(i));
		}
		await q.drain();
		assert.equal(log.warn.length, 1);
		assert.match(log.warn[0], /5 telegrams waiting/);
	});
});

describe('receive path of the adapter (main.js)', function () {
	allowTime(this);
	// Test button from the hand-over document: PTM215 003cd6c1, AI pressed, then released
	const BUTTON = '003cd6c1';
	const AI_PRESSED = radioFrame(0xf6, '10', BUTTON, 0x30, 60);
	const RELEASED = radioFrame(0xf6, '00', BUTTON, 0x20, 60);

	let env;
	afterEach(async () => {
		if (env) {
			await env.stop();
			env = null;
		}
	});

	it('builds the same frames as the hand-over document', () => {
		assert.equal(AI_PRESSED.toString('hex'), '55000707017af610003cd6c13001ffffffff3c009a');
		assert.equal(RELEASED.toString('hex'), '55000707017af600003cd6c12001ffffffff3c00d2');
	});

	it('writes a press completely before the following release, even when the database stalls', async () => {
		env = new TestEnv();
		env.addDevice(BUTTON, ['F6-02-03']);
		env.start();
		await env.waitConnected();

		// the device lookup for the press telegram hangs 300 ms; the release comes 80 ms after the press
		env.hangOnce('getObject', new RegExp(`^enocean\\.0\\.${BUTTON}$`), 300);
		env.inject(AI_PRESSED);
		await sleep(80);
		env.inject(RELEASED);
		await sleep(350);
		await env.settle();

		const writes = env.writesOf(BUTTON);
		const firstRelease = writes.indexOf('REL=true');
		assert.ok(firstRelease > 0, 'release written');
		assert.ok(writes.slice(0, firstRelease).includes('AI=true'), 'press wrote AI=true before the release');
		assert.equal(writes.slice(0, firstRelease).length, 9, 'all 9 data fields of the press before REL=true');
		assert.equal(env.state(`${BUTTON}.REL`), true);
		assert.equal(env.state(`${BUTTON}.AI`), false, 'AI must not stay pressed');
		assert.equal(env.unhandled.length, 0);
	});

	it('logs an error while processing a telegram and keeps receiving', async () => {
		env = new TestEnv();
		env.addDevice(BUTTON, ['F6-02-03']);
		env.addDevice('0badbeef', ['XX-99-99']); // EEP that does not exist -> exception inside main()
		env.start();
		await env.waitConnected();

		env.inject(radioFrame(0xf6, '30', '0badbeef', 0x30));
		env.inject(AI_PRESSED);
		await env.settle();

		assert.equal(env.unhandled.length, 0, 'no unhandled promise rejection (would stop the adapter)');
		assert.ok(
			env.logs.error.some((m) => m.includes('failed') && m.includes('rorg_number')),
			'error logged: ' + env.logs.error.join(' | '),
		);
		assert.equal(env.state(`${BUTTON}.AI`), true, 'the next telegram is processed');
	});

	it('feeds development.telegram through the same queue', async () => {
		env = new TestEnv();
		env.addDevice(BUTTON, ['F6-02-03']);
		env.addObject('development', { type: 'channel', common: { name: 'development' }, native: {} });
		env.start();
		await env.waitConnected();

		env.hangOnce('getObject', new RegExp(`^enocean\\.0\\.${BUTTON}$`), 200);
		await env.write('development.telegram', AI_PRESSED.toString('hex'));
		await sleep(30);
		env.inject(RELEASED);
		await sleep(250);
		await env.settle();

		const writes = env.writesOf(BUTTON);
		assert.ok(writes.indexOf('AI=true') >= 0 && writes.indexOf('AI=true') < writes.indexOf('REL=true'));
		assert.equal(env.state(`${BUTTON}.AI`), false);
		assert.equal(env.unhandled.length, 0);
	});
});
