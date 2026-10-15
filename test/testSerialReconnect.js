'use strict';

// Runs with mocha (npm run test:js) and with the Node test runner: node --test test/testSerialReconnect.js
const assert = require('node:assert/strict');
const { describe, it, afterEach } = typeof global.describe === 'function' ? global : require('node:test');

const { TestEnv, radioFrame, sleep } = require('./lib/harness');

/** mocha: more time than the default 2 s for these end-to-end tests (no-op with node --test) */
function allowTime(ctx) {
	if (ctx && typeof ctx.timeout === 'function') {
		ctx.timeout(10000);
	}
}

const BUTTON = '003cd6c1';
const AI_PRESSED = radioFrame(0xf6, '10', BUTTON, 0x30, 60);
const FL62 = '041450ed';
const FL62_NATIVE = { baseIDoffset: 31, Sender_ID: 'ffcf279f' };

function sentA5(env) {
	return env.radio.filter((d) => d[0] === 0xa5).map((d) => d.toString('hex'));
}

describe('serial port: reconnect', function () {
	allowTime(this);
	let env;
	afterEach(async () => {
		if (env) {
			await env.stop();
			env = null;
		}
	});

	it('opens the port again after it was closed, and receives each telegram once', async () => {
		env = new TestEnv();
		env.addDevice(BUTTON, ['F6-02-03']);
		const adapter = env.start();
		adapter.serialReconnectMs = [40, 80];
		await env.waitConnected();
		const first = env.port;

		first.disconnect();
		await env.waitFor(() => env.state('info.connection') === false, 500, 'info.connection false');
		assert.ok(
			env.logs.warn.some((m) => m.startsWith('The serial port was closed. Next attempt in 0.04 s (attempt 1)')),
			env.logs.warn.join(' | '),
		);

		await env.waitConnected(1500);
		assert.notEqual(env.port, first);
		assert.equal(env.ports.length, 2);
		assert.ok(env.logs.info.some((m) => m.includes('is open again')));

		env.inject(AI_PRESSED);
		await env.settle();
		assert.deepEqual(
			env.writesOf(BUTTON).filter((w) => w === 'AI=true'),
			['AI=true'],
			'telegram processed exactly once',
		);
		assert.equal(env.unhandled.length, 0);
	});

	it('keeps trying while the stick is missing at start, and logs only the first attempts', async () => {
		env = new TestEnv();
		env.devicePresent = false;
		const adapter = env.start();
		adapter.serialReconnectMs = [10, 20];
		await env.waitFor(() => env.openAttempts >= 6, 2000, 'six attempts');
		const warnings = env.logs.warn.filter((m) => m.startsWith('Cannot open serial port /dev/ttyTEST'));
		assert.equal(warnings.length, 3, warnings.join(' | '));
		assert.equal(env.state('info.connection'), false);

		env.devicePresent = true;
		await env.waitConnected(1500);
		assert.equal(env.state('info.connection'), true);
		assert.equal(env.unhandled.length, 0);
	});

	it('sends a telegram queued during the outage once the port is back', async () => {
		env = new TestEnv();
		env.addDevice(FL62, ['TF-13-11', 'TF-14-02'], FL62_NATIVE);
		const adapter = env.start();
		adapter.serialReconnectMs = [150];
		await env.waitConnected();

		env.port.disconnect();
		await env.write(`${FL62}.CMD`, 1);
		await sleep(80);
		assert.deepEqual(sentA5(env), [], 'nothing sent while the port is closed');
		assert.equal(env.heldWrites.length, 0, 'nothing written to the closed port');

		await env.waitConnected(1500);
		await env.waitFor(() => sentA5(env).length > 0, 1000, 'telegram after reconnect');
		assert.deepEqual(sentA5(env), ['a501000009ffcf279f00']);
	});

	it('drops a queued telegram that waited too long', async () => {
		env = new TestEnv();
		env.addDevice(FL62, ['TF-13-11', 'TF-14-02'], FL62_NATIVE);
		const adapter = env.start();
		adapter.serialReconnectMs = [300];
		adapter.sendMaxAgeMs = 100;
		await env.waitConnected();

		env.port.disconnect();
		await env.write(`${FL62}.CMD`, 1);
		await env.waitConnected(1500);
		await sleep(150);
		assert.deepEqual(sentA5(env), []);
		assert.ok(env.logs.warn.some((m) => m.startsWith('1 telegram(s) not sent within 0.1 s')));
	});

	it('does not report a connection when the port closed while the gateway was read', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [5000];
		// the stick disappears at the last start-up command (SA_RD_LEARNEDCLIENTS), which then times out
		env.onPacket = (port, type) => {
			if (type === 6) {
				port.disconnect();
			}
		};
		await env.waitFor(() => env.logs.warn.some((m) => m.includes('Read learnd devices')), 3000, 'start-up done');
		await env.settle();
		assert.equal(env.state('info.connection'), false);
		assert.equal(env.unhandled.length, 0);
	});

	it('closes and reopens a port that hangs without a close event (USB disconnect, serialport 10 on Linux)', async () => {
		env = new TestEnv();
		env.addDevice(BUTTON, ['F6-02-03']);
		const adapter = env.start();
		adapter.serialReconnectMs = [20];
		adapter.serialCheckMs = 30;
		await env.waitConnected();
		const first = env.port;

		first.hangUp();
		await env.waitFor(() => env.port !== first && env.connected(), 1500, 'reconnect after hang-up');
		assert.ok(
			env.logs.warn.some((m) => m.startsWith('Serial port /dev/ttyTEST does not respond (EIO: i/o error, drain), closing it')),
			env.logs.warn.join(' | '),
		);
		assert.equal(first.isOpen, false);

		env.inject(AI_PRESSED);
		await env.settle();
		assert.equal(env.state(`${BUTTON}.AI`), true);
		assert.equal(env.unhandled.length, 0);
	});

	it('closes and reopens a port whose drain() does not return', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [20];
		adapter.serialCheckMs = 20;
		await env.waitConnected();
		const first = env.port;

		first.drainHangs = true;
		await env.waitFor(() => env.port !== first && env.connected(), 1500, 'reconnect');
		assert.ok(
			env.logs.warn.some((m) => m.startsWith('Serial port /dev/ttyTEST does not respond (drain does not return), closing it')),
			env.logs.warn.join(' | '),
		);
	});

	it('backs off when the stick drops again right after opening', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [20, 40, 80];
		await env.waitConnected();

		for (let i = 0; i < 3; i++) {
			env.port.disconnect();
			await env.waitConnected(1500);
		}
		const attempts = env.logs.warn.filter((m) => m.startsWith('The serial port was closed'));
		assert.deepEqual(
			attempts.map((m) => m.replace(/^.*Next attempt in /, '')),
			['0.02 s (attempt 1)', '0.04 s (attempt 2)', '0.08 s (attempt 3)'],
		);
	});

	it('starts again with the first delay after the port was open long enough', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [20, 40, 80];
		adapter.serialStableMs = 100;
		await env.waitConnected();

		env.port.disconnect();
		await env.waitConnected(1500);
		await sleep(150);
		env.port.disconnect();
		await env.waitConnected(1500);
		const attempts = env.logs.warn.filter((m) => m.startsWith('The serial port was closed'));
		assert.deepEqual(
			attempts.map((m) => m.replace(/^.*Next attempt in /, '')),
			['0.02 s (attempt 1)', '0.02 s (attempt 1)'],
		);
	});

	it('sends nothing to the gateway before its start-up is done', async () => {
		env = new TestEnv();
		env.addDevice(FL62, ['TF-13-11', 'TF-14-02'], FL62_NATIVE);
		const adapter = env.start();
		adapter.serialReconnectMs = [20];
		await env.waitConnected();

		env.answerDelayMs = 40; // slow answers: the start-up takes about 0.2 s
		env.port.disconnect();
		await env.write(`${FL62}.CMD`, 1);
		await env.waitConnected(2000);
		await env.waitFor(() => sentA5(env).length > 0, 1000, 'telegram after reconnect');

		const types = env.port.sent.map((p) => p[4]);
		assert.ok(types.indexOf(1) > types.indexOf(6), `radio telegram after the last start-up command: ${types}`);
	});

	it('stops a start-up whose port closes', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [5000];
		// the stick goes away at the first start-up command, which then times out after 1.5 s
		env.onPacket = (port, type, data) => {
			if (type === 5 && data[0] === 0x03) {
				port.disconnect();
			}
		};
		await env.waitFor(() => env.logs.warn.some((m) => m.includes('Get version information')), 2500, 'timeout');
		await sleep(200);
		assert.equal(env.heldWrites.length, 0, 'no further start-up commands to the closed port');
		assert.equal(env.logs.error.length, 0, env.logs.error.join(' | '));
		assert.equal(env.state('info.connection'), false);
	});

	it('a start-up interrupted by a disconnect does not disturb the next one', async () => {
		env = new TestEnv();
		env.addDevice(FL62, ['TF-13-11', 'TF-14-02'], FL62_NATIVE);
		const adapter = env.start();
		adapter.serialReconnectMs = [50];
		// the first port goes away at its first start-up command (CO_RD_VERSION), unanswered
		env.onPacket = (port, type, data) => {
			if (port === env.ports[0] && type === 5 && data[0] === 0x03) {
				port.disconnect();
			}
		};
		await env.waitFor(() => env.ports.length === 2 && env.connected(), 2000, 'second port connected');
		// the first start-up waits 1.5 s for its answer, then has to give up
		await env.waitFor(() => env.logs.warn.some((m) => m.includes('Get version information')), 2500, 'timeout');
		await sleep(100);
		await env.settle();

		const commands = env.ports[1].sent.map((p) => `${p[4]}:${p[6].toString(16)}`);
		assert.deepEqual(commands, ['5:3', '5:a', '5:25', '5:8', '6:6'], 'each start-up command once on the new port');
		assert.equal(env.objects['enocean.0.gateway'].native.AppVersion, '2.11.1.0');
		assert.equal(env.logs.error.length, 0, env.logs.error.join(' | '));
		assert.equal(env.state('info.connection'), true);
		// the first start-up, ending last, must not take the new port's place
		assert.equal(adapter.serialReady, env.ports[1]);
		await env.write(`${FL62}.CMD`, 1);
		await env.waitFor(() => sentA5(env).length > 0, 1000, 'telegram on the new port');
		assert.equal(env.ports[1].sent.filter((p) => p[4] === 1).length, 1);
	});

	it('does not open the port again after unload', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [100];
		await env.waitConnected();

		env.port.disconnect();
		const stopped = env;
		await env.stop();
		env = null;
		await sleep(200);
		assert.equal(stopped.ports.length, 1);
	});

	it('closes the port and does not reopen it after a normal unload', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [20];
		await env.waitConnected();

		const stopped = env;
		const port = env.port;
		await env.stop();
		env = null;
		await sleep(100);
		assert.equal(port.isOpen, false);
		assert.equal(stopped.ports.length, 1);
	});

	it('closes a port that finishes opening after unload', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [10];
		await env.waitConnected();

		env.openDelayMs = 100;
		env.port.disconnect();
		await env.waitFor(() => env.ports.length === 2, 500, 'reopen started');
		const stopped = env;
		await env.stop(); // while the second port is still opening
		env = null;
		await sleep(200);
		assert.equal(stopped.ports[1].isOpen, false);
		assert.equal(stopped.ports[1].sent.length, 0, 'no start-up on the late port');
	});

	it('runs one send loop also after reconnects: one telegram per 50 ms', async () => {
		env = new TestEnv();
		env.addDevice(FL62, ['TF-13-11', 'TF-14-02'], FL62_NATIVE);
		const adapter = env.start();
		adapter.serialReconnectMs = [20];
		await env.waitConnected();
		for (let i = 0; i < 2; i++) {
			env.port.disconnect();
			await env.waitConnected(1500);
		}

		for (const cmd of [1, 0, 1, 0]) {
			await env.write(`${FL62}.CMD`, cmd);
		}
		await env.waitFor(() => sentA5(env).length === 4, 2000, 'four telegrams');
		const gaps = env.radioTimes.slice(1).map((t, i) => t - env.radioTimes[i]);
		assert.ok(Math.min(...gaps) >= 40, `gaps ${gaps}`);
	});
});
