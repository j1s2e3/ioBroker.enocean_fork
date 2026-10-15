'use strict';

// Runs with mocha (npm run test:js) and with the Node test runner: node --test test/testSmallFixes.js
const assert = require('node:assert/strict');
const { describe, it, afterEach } = typeof global.describe === 'function' ? global : require('node:test');

const { TestEnv, esp3, radioFrame, sleep } = require('./lib/harness');

/** mocha: more time than the default 2 s for these end-to-end tests (no-op with node --test) */
function allowTime(ctx) {
	if (ctx && typeof ctx.timeout === 'function') {
		ctx.timeout(10000);
	}
}

const BUTTON = '003cd6c1';
const FD62 = '04140b28';
const FD62_NATIVE = { baseIDoffset: 49, Sender_ID: 'ffcf27b1' };
const FTAF55 = '0410bb93';
const FTAF55_NATIVE = { baseIDoffset: 62, Sender_ID: 'ffcf27be' };
const BLIND = '05aa0001'; // TF-13-03 (blind actuator, legacy profile)
const BLIND_NATIVE = { baseIDoffset: 64, Sender_ID: 'ffcf27c0' };

function sentA5(env) {
	return env.radio.filter((d) => d[0] === 0xa5).map((d) => d.toString('hex'));
}

function repeaterStates(env) {
	const mode = env.states['enocean.0.gateway.repeater.mode'];
	const level = env.states['enocean.0.gateway.repeater.level'];
	return { mode: mode.val, modeAck: mode.ack, level: level.val, levelAck: level.ack };
}

describe('small fixes', function () {
	allowTime(this);
	let env;
	afterEach(async () => {
		if (env) {
			await env.stop();
			env = null;
		}
	});

	it('ignores echoes of its own telegrams before any database access', async () => {
		env = new TestEnv();
		env.addDevice(BUTTON, ['F6-02-03']);
		env.start();
		await env.waitConnected();

		// FL62 command of the gateway (sender ffcf279f = base + 0x1f), repeated back once, status 0x81
		env.inject(radioFrame(0xa5, '01000008', 'ffcf279f', 0x81, 73));
		env.inject(radioFrame(0xf6, '30', BUTTON, 0x30));
		await env.settle();

		assert.equal(env.calls.filter((c) => c.id === 'enocean.0.ffcf279f').length, 0, 'no database access for the echo');
		assert.ok(env.logs.debug.some((m) => m.startsWith('Echo of own telegram (sender ffcf279f, repeated 1 times)')));
		assert.notEqual(env.state('gateway.lastID'), 'ffcf279f');
		assert.equal(env.state(`${BUTTON}.A0`), true, 'device telegrams are processed as before');
	});

	it('treats exactly base ID .. base ID + 127 as own (ffcf27ff own, ffcf2800 a device)', async () => {
		env = new TestEnv();
		env.addDevice('ffcf2800', ['F6-02-03']);
		env.start();
		await env.waitConnected();

		env.inject(radioFrame(0xf6, '30', 'ffcf27ff', 0x01));
		env.inject(radioFrame(0xf6, '30', 'ffcf2800', 0x30));
		await env.settle();

		assert.equal(env.calls.filter((c) => c.id === 'enocean.0.ffcf27ff').length, 0);
		assert.equal(env.state('ffcf2800.A0'), true);
	});

	it('rounds and limits values from states before they go into a telegram', async () => {
		env = new TestEnv();
		env.addDevice(FD62, ['TF-13-07', 'TF-13-06'], FD62_NATIVE);
		env.start();
		await env.waitConnected();

		const cases = [
			[43.3, '2b'],
			[12.5, '0d'],
			[300, 'ff'],
			['20', '14'],
			[-5, '00'],
		];
		for (const [lvl] of cases) {
			await env.write(`${FD62}.LVL`, lvl);
			await env.write(`${FD62}.CMD`, 2);
			await sleep(80);
		}
		await env.waitFor(() => sentA5(env).length === cases.length, 2000, 'five dim telegrams');
		assert.deepEqual(
			sentA5(env),
			cases.map(([, hex]) => `a502${hex}0009ffcf27b100`),
		);
		assert.equal(env.logs.warn.filter((m) => m.includes('data length')).length, 0);
		const fit = env.logs.warn.filter((m) => m.includes('does not fit'));
		assert.deepEqual(fit, [
			`enocean.0.${FD62}.CMD: LVL = 300 does not fit into the telegram (8 bit), sending 255`,
			`enocean.0.${FD62}.CMD: LVL = -5 does not fit into the telegram (8 bit), sending 0`,
		]);
	});

	it('writes a boolean field as one bit (TF-13-03: block local switch)', async () => {
		env = new TestEnv();
		env.addDevice(BLIND, ['TF-13-03'], BLIND_NATIVE);
		env.start();
		await env.waitConnected();

		await env.write(`${BLIND}.RT`, 300);
		await env.write(`${BLIND}.BS`, true);
		await env.write(`${BLIND}.CMD`, 1);
		await env.waitFor(() => sentA5(env).length === 1, 2000, 'blind telegram');
		// running time 300 (0x012c), command 1, learn bit, BS, 100 ms
		assert.deepEqual(sentA5(env), ['a5012c010effcf27c000']);
	});

	it('keeps the conversion of value_out fields (FTAF55D set point 21.5 -> 0x89)', async () => {
		env = new TestEnv();
		env.addDevice(FTAF55, ['TF-13-20', 'TF-14-02'], FTAF55_NATIVE);
		env.start();
		await env.waitConnected();

		await env.write(`${FTAF55}.SP`, 21.5);
		await env.write(`${FTAF55}.CMD`, 0);
		await env.waitFor(() => sentA5(env).length === 1, 2000, 'set point telegram');
		assert.deepEqual(sentA5(env), ['a500890008ffcf27be00']);
		assert.equal(env.logs.warn.length, 0, env.logs.warn.join(' | '));
	});

	it('does not write the repeater setting back at start', async () => {
		env = new TestEnv();
		env.start();
		await env.waitConnected();
		await sleep(100);
		await env.settle();

		assert.deepEqual(env.repeaterWrites, []);
		assert.deepEqual(repeaterStates(env), { mode: 1, modeAck: true, level: 1, levelAck: true });
	});

	it('sets the repeater on request and acknowledges what the gateway reports', async () => {
		env = new TestEnv();
		env.start();
		await env.waitConnected();

		// off: mode 0 also sets level 0, as other ESP3 hosts send it
		await env.write('gateway.repeater.mode', 0);
		await env.waitFor(() => env.states['enocean.0.gateway.repeater.mode'].ack === true, 2000, 'ack');
		await env.settle();
		assert.deepEqual(env.repeaterWrites, [[0, 0]]);
		assert.deepEqual(env.repeater, { mode: 0, level: 0 });
		assert.deepEqual(repeaterStates(env), { mode: 0, modeAck: true, level: 0, levelAck: true });
		assert.ok(env.logs.info.includes('Gateway repeater set: mode 0, level 0'), env.logs.info.join(' | '));
	});

	it('switches the repeater off with level 0 and on again with mode 1', async () => {
		env = new TestEnv();
		env.start();
		await env.waitConnected();

		await env.write('gateway.repeater.level', 0);
		await env.waitFor(() => env.repeaterWrites.length === 1, 2000, 'off');
		await env.settle();
		await env.write('gateway.repeater.mode', 1);
		await env.waitFor(() => env.repeaterWrites.length === 2, 2000, 'on');
		await env.settle();
		assert.deepEqual(env.repeaterWrites, [[0, 0], [1, 1]]);
		assert.deepEqual(repeaterStates(env), { mode: 1, modeAck: true, level: 1, levelAck: true });
	});

	it('shows the gateway setting again when the gateway refuses, also with radio traffic in between', async () => {
		env = new TestEnv();
		env.addDevice(FD62, ['TF-13-07', 'TF-13-06'], FD62_NATIVE);
		env.start();
		await env.waitConnected();
		env.repeaterAnswer = 0x03; // RET_WRONG_PARAM
		env.answerDelayMs = 15;

		// a radio telegram goes out just before; its RET_OK must not count as answer to the repeater command
		await env.write(`${FD62}.CMD`, 0);
		await env.waitFor(() => sentA5(env).length === 1, 1000, 'radio telegram');
		await env.write('gateway.repeater.level', 7);
		await env.waitFor(() => env.states['enocean.0.gateway.repeater.level'].ack === true, 2000, 'read back');
		await env.settle();

		assert.deepEqual(repeaterStates(env), { mode: 1, modeAck: true, level: 1, levelAck: true });
		assert.deepEqual(env.repeater, { mode: 1, level: 1 }, 'gateway unchanged');
		assert.ok(
			env.logs.warn.includes('Gateway did not accept repeater mode 1, level 7, it uses mode 1, level 1'),
			env.logs.warn.join(' | '),
		);
		assert.ok(env.logs.warn.some((m) => m.startsWith('Gateway answered WRONG PARAMETER to 5500030005')));
	});

	it('handles a second repeater change while the first is under way', async () => {
		env = new TestEnv();
		env.start();
		await env.waitConnected();
		env.answerDelayMs = 30;

		// off, and while that waits for the gateway: level 2, which switches it on again
		await env.write('gateway.repeater.mode', 0);
		await sleep(5);
		await env.write('gateway.repeater.level', 2);
		await env.waitFor(() => env.repeaterWrites.length === 2, 2000, 'both changes');
		await sleep(150);
		await env.settle();
		assert.deepEqual(env.repeaterWrites, [[0, 0], [1, 2]]);
		assert.deepEqual(env.repeater, { mode: 1, level: 2 });
		assert.deepEqual(repeaterStates(env), { mode: 1, modeAck: true, level: 2, levelAck: true });
		assert.equal(env.logs.warn.length, 0, env.logs.warn.join(' | '));
	});

	it('does not change the repeater while the gateway starts up', async () => {
		env = new TestEnv();
		const adapter = env.start();
		adapter.serialReconnectMs = [20];
		await env.waitConnected();

		env.answerDelayMs = 40; // the start-up after the reconnect takes about 0.2 s
		env.port.disconnect();
		await env.waitFor(() => env.ports.length === 2 && env.ports[1].isOpen, 1000, 'reopened');
		await env.write('gateway.repeater.level', 2);
		await env.waitConnected(3000);
		await sleep(100);
		await env.settle();

		assert.deepEqual(env.repeaterWrites, []);
		assert.ok(env.logs.warn.some((m) => m.startsWith('Gateway not ready, repeater setting not changed')));
		assert.equal(env.logs.warn.filter((m) => m.startsWith('Gateway did not accept')).length, 0);
		const native = env.objects['enocean.0.gateway'].native;
		assert.equal(native.AppVersion, '2.11.1.0');
		assert.equal(native.BaseID, 'ffcf2780');
		assert.deepEqual(repeaterStates(env), { mode: 1, modeAck: true, level: 1, levelAck: true });
	});

	it('warns when the gateway refuses to send a telegram, naming that telegram', async () => {
		env = new TestEnv();
		env.addDevice(FD62, ['TF-13-07', 'TF-13-06'], FD62_NATIVE);
		env.start();
		await env.waitConnected();
		// the first telegram is refused, the second sent; each answer comes after the next telegram went out
		env.radioAnswer = () => (env.radio.length === 1 ? 0x05 : 0x00); // DUTY CYCLE LOCK
		env.answerDelayMs = 70;

		await env.write(`${FD62}.CMD`, 0);
		await env.write(`${FD62}.LVL`, 50);
		await env.write(`${FD62}.CMD`, 2);
		await env.waitFor(() => sentA5(env).length === 2, 2000, 'two telegrams');
		await sleep(150);
		await env.settle();

		const warnings = env.logs.warn.filter((m) => m.startsWith('Gateway answered'));
		assert.equal(warnings.length, 1, env.logs.warn.join(' | '));
		assert.ok(warnings[0].startsWith('Gateway answered DUTY CYCLE LOCK to 55000a0701eba502000008'), warnings[0]);
	});

	it('waitForResponse takes only RESPONSE packets and removes its listener after a timeout', async () => {
		env = new TestEnv();
		env.start();
		await env.waitConnected();
		const parser = env.port.parser;
		const listeners = parser.listenerCount('data');

		// a radio telegram with data length 7 is no answer to a command expecting 7 bytes
		const waiting = env.adapter.waitForResponse('test', 7);
		env.inject(radioFrame(0xf6, '30', BUTTON, 0x30));
		const response = esp3(2, [0x00, 1, 2, 3, 4, 5, 6]);
		await sleep(20);
		env.inject(response);
		assert.equal((await waiting).toString('hex'), response.toString('hex'));
		assert.equal(parser.listenerCount('data'), listeners);

		// nothing comes: rejected after 1.5 s, listener gone
		await assert.rejects(env.adapter.waitForResponse('nothing', 99), /Timeout for response: nothing/);
		assert.equal(parser.listenerCount('data'), listeners);
	});
});
