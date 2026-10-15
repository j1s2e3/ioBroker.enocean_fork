'use strict';

// Runs with mocha (npm run test:js) and with the Node test runner: node --test test/testInfoStates.js
const assert = require('node:assert/strict');
const { describe, it, afterEach } = typeof global.describe === 'function' ? global : require('node:test');

const { TestEnv, esp3, radioFrame } = require('./lib/harness');

/** mocha: more time than the default 2 s for these end-to-end tests (no-op with node --test) */
function allowTime(ctx) {
	if (ctx && typeof ctx.timeout === 'function') {
		ctx.timeout(10000);
	}
}

// FRGBW71L in the living room ("ioBroker controls Master", EEP TF-13-21) and its slave. A confirmation
// A5 03 FF 10 0E reports channel R = 1023; it comes via the repeater (status 0x01) at -74 dBm.
const RGBW = 'ffb2fd86';
const SLAVE = 'ffc6ef86';
const R_ON = radioFrame(0xa5, '03ff100e', RGBW, 0x01, 0x4a);
const R_OFF = radioFrame(0xa5, '0000100e', RGBW, 0x01, 0x4a);
const SLAVE_R_ON = radioFrame(0xa5, '03ff100e', SLAVE, 0x02, 0x47);
// the same confirmation as RADIO_SUB_TEL (ERP1 data; optional data up to the security level, the adapter reads only
// the dBm byte) and as RADIO_ERP2 in the layout RadioTelegram_ERP2 reads (header 0x07 = 4BS, data, sender, status)
const R_ON_SUBTEL = esp3(3, Buffer.from(`a503ff100e${RGBW}01`, 'hex'), [0x03, 0xff, 0xff, 0xff, 0xff, 0x4a, 0x00]);
const R_ON_ERP2 = esp3(10, Buffer.from(`0703ff100e${RGBW}0100`, 'hex'), [0x01, 0x4a]);
// PTM215 from the hand-over document, AI pressed
const BUTTON = '003cd6c1';
const AI_PRESSED = radioFrame(0xf6, '10', BUTTON, 0x30, 60);

const idOf = (id) => new RegExp(`^enocean\\.0\\.${id.replace(/\./g, '\\.')}$`);

/** absolute time of the first write of this state after `since` (ms since epoch), or null */
function writeTime(env, id, since) {
	const w = env.writes.find((x) => x.id === `enocean.0.${id}` && env.t0 + x.t >= since);
	return w ? env.t0 + w.t : null;
}

/** start the adapter; then make every database call a round trip, as with js-controller 7.2.5 on the Pi */
async function startLikeThePi(env, latencyMs) {
	env.start();
	await env.waitConnected();
	await env.settle();
	// requests on one connection are pipelined, each answer comes latencyMs later (no queueing in the database:
	// the best case for writes that run at the same time). setState reads the object twice and the old state once,
	// then writes: four round trips.
	env.latencyMs = latencyMs;
	env.objectReadsPerSetState = 2;
	env.stateReadsPerSetState = 1;
}

/** start the adapter with a FRGBW71L, gateway idle */
async function startWithRgbw(env) {
	env.addDevice(RGBW, ['TF-13-21']);
	env.start();
	await env.waitConnected();
	await env.settle();
}

describe('received telegrams: rssi, repeated and lastID beside the device states', function () {
	allowTime(this);
	let env;
	afterEach(async () => {
		if (env) {
			await env.stop();
			env = null;
		}
	});

	it('writes the device state without waiting for rssi, repeated and lastID', async () => {
		const L = 30;
		env = new TestEnv();
		env.addDevice(RGBW, ['TF-13-21']);
		await startLikeThePi(env, L);

		const t0 = Date.now();
		env.inject(R_ON);
		await env.waitFor(() => env.state(`${RGBW}.R`) === 1023, 2000, 'R written');
		await env.adapter.rxQueue.drain();
		const done = Date.now() - t0;
		const r = writeTime(env, `${RGBW}.R`, t0) - t0;

		// R: teachin, device object, its own setState (4 round trips) = 6; before, rssi and repeated came first
		// (15). Done when repeated is written (object check, setState: 7); before, lastID followed (19 in all).
		assert.ok(r < 9 * L, `R written after ${r} ms, expected about ${6 * L}`);
		assert.ok(done < 9 * L, `telegram done after ${done} ms, expected about ${7 * L}`);
		assert.ok(done >= 5.5 * L, `latency model active (${done} ms)`);
		assert.equal(env.state(`${RGBW}.rssi`), -74);
		assert.equal(env.state(`${RGBW}.repeated`), 1);
		assert.equal(env.state('gateway.lastID'), RGBW);
		assert.equal(env.logs.error.length, 0, env.logs.error.join(' | '));
		assert.equal(env.unhandled.length, 0);
	});

	it('writes the data fields of a button telegram in their order, sooner than before', async () => {
		const L = 20;
		env = new TestEnv();
		env.addDevice(BUTTON, ['F6-02-03']);
		await startLikeThePi(env, L);

		const t0 = Date.now();
		env.inject(AI_PRESSED);
		await env.waitFor(() => env.state(`${BUTTON}.AIB0`) === false, 5000, 'press written');
		await env.adapter.rxQueue.drain();
		const done = Date.now() - t0;

		assert.deepEqual(env.writesOf(BUTTON), [
			'REL=false',
			'A0=false',
			'AI=true',
			'B0=false',
			'BI=false',
			'A0B0=false',
			'AIBI=false',
			'A0BI=false',
			'AIB0=false',
		]);
		// teachin, device object, 9 data fields of 4 round trips each = 38; before 51
		assert.ok(done < 44 * L, `press done after ${done} ms, expected about ${38 * L}`);
		assert.ok(done >= 33 * L, `latency model active, data fields one after another (${done} ms)`);
		assert.equal(env.unhandled.length, 0);
	});

	it('creates the object repeated once per device, writes the state every time', async () => {
		env = new TestEnv();
		env.addDevice(SLAVE, ['TF-13-21']);
		await startWithRgbw(env);

		for (const frame of [R_ON, R_OFF, SLAVE_R_ON, R_ON]) {
			env.inject(frame);
			await env.settle();
		}

		const checks = (dev) =>
			env.calls.filter((c) => c.op === 'setObjectNotExists' && c.id === `enocean.0.${dev}.repeated`).length;
		assert.equal(checks(RGBW), 1);
		assert.equal(checks(SLAVE), 1);
		assert.ok(env.objects[`enocean.0.${RGBW}.repeated`], 'object created for an older installation');
		assert.equal(env.writes.filter((w) => w.id === `enocean.0.${RGBW}.repeated`).length, 3);
		assert.equal(env.state(`${SLAVE}.repeated`), 2);
		assert.equal(env.state(`${RGBW}.R`), 1023);
		assert.equal(env.logs.error.length, 0, env.logs.error.join(' | '));
	});

	it('writes the state repeated only after its object exists', async () => {
		env = new TestEnv();
		await startWithRgbw(env);
		// first telegram of an older installation: creating the object takes a while
		env.hangOnce('setObjectNotExists', idOf(`${RGBW}.repeated`), 100);
		const withoutObject = [];
		const push = env.writes.push.bind(env.writes);
		env.writes.push = (w) => {
			if (!env.objects[w.id]) {
				withoutObject.push(w.id);
			}
			return push(w);
		};

		env.inject(R_ON);
		await env.settle();

		assert.equal(env.state(`${RGBW}.repeated`), 1);
		assert.deepEqual(
			withoutObject.filter((id) => id.endsWith('.repeated')),
			[],
			'js-controller would warn "has no existing object"',
		);
	});

	it('tries to create the object repeated again after a failed attempt', async () => {
		env = new TestEnv();
		await startWithRgbw(env);
		env.failOnce('setObjectNotExists', idOf(`${RGBW}.repeated`), 'object write failed');

		env.inject(R_ON);
		await env.settle();
		assert.equal(env.state(`${RGBW}.R`), 1023, 'device state written despite the failure');
		env.inject(R_OFF);
		await env.settle();

		const checks = env.calls.filter((c) => c.op === 'setObjectNotExists' && c.id === `enocean.0.${RGBW}.repeated`);
		assert.equal(checks.length, 2);
		assert.ok(env.objects[`enocean.0.${RGBW}.repeated`]);
		assert.equal(env.logs.error.length, 1);
		assert.match(env.logs.error[0], /object write failed/);
		assert.equal(env.state(`${RGBW}.R`), 0);
	});

	it('writes the device state even if rssi cannot be written, and logs that once', async () => {
		env = new TestEnv();
		await startWithRgbw(env);
		env.failOnce('setState', idOf(`${RGBW}.rssi`), 'rssi write failed');

		env.inject(R_ON);
		await env.settle();

		assert.equal(env.state(`${RGBW}.R`), 1023, 'device state written');
		assert.equal(env.state(`${RGBW}.repeated`), 1);
		assert.equal(env.state('gateway.lastID'), RGBW);
		assert.equal(env.logs.error.length, 1, env.logs.error.join(' | '));
		assert.match(env.logs.error[0], /rssi write failed/, 'reported by the receive queue');
		assert.equal(env.unhandled.length, 0);

		env.inject(R_OFF);
		await env.settle();
		assert.equal(env.state(`${RGBW}.R`), 0, 'the next telegram is processed normally');
		assert.equal(env.logs.error.length, 1);
	});

	it('logs an error when only lastID cannot be written', async () => {
		env = new TestEnv();
		await startWithRgbw(env);
		env.failOnce('setState', /^enocean\.0\.gateway\.lastID$/, 'lastID write failed');

		env.inject(R_ON);
		await env.settle();

		assert.equal(env.state(`${RGBW}.R`), 1023);
		assert.equal(env.logs.error.length, 1, env.logs.error.join(' | '));
		assert.match(env.logs.error[0], /lastID write failed/);
		assert.equal(env.unhandled.length, 0);
	});

	// the telegram counts as done only when all its writes have finished, also when one of them fails; for every
	// packet type that goes through a handler (ERP2 has no rssi)
	const PACKETS = {ERP1: R_ON, RADIO_SUB_TEL: R_ON_SUBTEL, ERP2: R_ON_ERP2};
	for (const [type, frame] of Object.entries(PACKETS)) {
		const failingStates = type === 'ERP2' ? [`${RGBW}.R`, 'gateway.lastID'] : [`${RGBW}.R`, `${RGBW}.rssi`, 'gateway.lastID'];
		for (const failing of failingStates) {
			it(`${type}: done only when repeated is written, also if ${failing} fails`, async () => {
				env = new TestEnv();
				await startWithRgbw(env);
				env.failOnce('setState', idOf(failing), `${failing} write failed`);
				env.hangOnce('setState', idOf(`${RGBW}.repeated`), 150);

				env.inject(frame);
				const repeatedId = `enocean.0.${RGBW}.repeated`;
				await env.waitFor(() => env.calls.some((c) => c.op === 'setState' && c.id === repeatedId), 1000, 'repeated');
				await env.adapter.rxQueue.drain();

				// the next telegram must not start while this one is still writing
				assert.equal(env.state(`${RGBW}.repeated`), 1, 'repeated written before the telegram counts as done');
				assert.equal(env.logs.error.length, 1, env.logs.error.join(' | '));
				assert.ok(env.logs.error[0].includes(`${failing} write failed`), env.logs.error[0]);
				assert.equal(env.unhandled.length, 0);
			});
		}
	}

	it('reports the device state error, without an unhandled rejection, when rssi and lastID fail too', async () => {
		env = new TestEnv();
		await startWithRgbw(env);
		env.failOnce('setState', idOf(`${RGBW}.R`), 'R write failed');
		env.failOnce('setState', idOf(`${RGBW}.rssi`), 'rssi write failed');
		env.failOnce('setState', /^enocean\.0\.gateway\.lastID$/, 'lastID write failed');

		env.inject(R_ON);
		await env.settle();

		assert.equal(env.unhandled.length, 0, 'no unhandled promise rejection (would stop the adapter)');
		assert.equal(env.logs.error.length, 1, env.logs.error.join(' | '));
		assert.match(env.logs.error[0], /R write failed/);
		assert.equal(env.state(`${RGBW}.repeated`), 1, 'the other writes of the telegram still happen');

		env.inject(R_OFF);
		await env.settle();
		assert.equal(env.state(`${RGBW}.R`), 0);
		assert.equal(env.state('gateway.lastID'), RGBW);
	});

	it('handles a RADIO_SUB_TEL packet like ERP1', async () => {
		env = new TestEnv();
		await startWithRgbw(env);

		env.inject(R_ON_SUBTEL);
		await env.settle();

		assert.equal(env.state(`${RGBW}.R`), 1023);
		assert.equal(env.state(`${RGBW}.rssi`), -74);
		assert.equal(env.state(`${RGBW}.repeated`), 1);
		assert.equal(env.state('gateway.lastID'), RGBW);
		assert.equal(env.logs.error.length, 0, env.logs.error.join(' | '));
	});

	it('writes repeated and lastID for an ERP2 packet, and reports a failing lastID', async () => {
		env = new TestEnv();
		await startWithRgbw(env);
		env.failOnce('setState', /^enocean\.0\.gateway\.lastID$/, 'lastID write failed');

		env.inject(R_ON_ERP2);
		await env.settle();

		assert.equal(env.state(`${RGBW}.R`), 1023);
		assert.equal(env.state(`${RGBW}.repeated`), 1);
		assert.equal(env.writes.filter((w) => w.id === `enocean.0.${RGBW}.rssi`).length, 0, 'ERP2 has no rssi state');
		assert.equal(env.logs.error.length, 1, env.logs.error.join(' | '));
		assert.match(env.logs.error[0], /lastID write failed/);
		assert.equal(env.unhandled.length, 0);

		env.inject(R_ON_ERP2);
		await env.settle();
		assert.equal(env.state('gateway.lastID'), RGBW);
	});
});
