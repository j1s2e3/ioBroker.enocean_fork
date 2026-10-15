'use strict';

// Runs with mocha (npm run test:js) and with the Node test runner: node --test test/testSendPath.js
const assert = require('node:assert/strict');
const { describe, it, afterEach } = typeof global.describe === 'function' ? global : require('node:test');

const net = require('net');
const { performance } = require('perf_hooks');
const { TestEnv, sleep } = require('./lib/harness');

/** mocha: more time than the default 2 s for these end-to-end tests (no-op with node --test) */
function allowTime(ctx) {
	if (ctx && typeof ctx.timeout === 'function') {
		ctx.timeout(10000);
	}
}

// FRGBW71L "ioBroker controls Master" (TF-13-21) with own sender IDs, as in the living room: ROUT + CMD 0 sends
// channel R. A third one without own sender ID uses the base ID of the gateway (ffcf2780).
const RGBW = 'ffb2fd86';
const RGBW_NATIVE = { baseIDoffset: 49, Sender_ID: 'ffcf27b1' };
const SLAVE = 'ffc6ef86';
const SLAVE_NATIVE = { baseIDoffset: 73, Sender_ID: 'ffcf27c9' };
const PLAIN = 'ffc74006';
const R_FULL_RGBW = 'a503ff100fffcf27b100';
const R_FULL_SLAVE = 'a503ff100fffcf27c900';
// FD62 dimmer (TF-13-07): CMD 2 sends LVL and DS
const FD62 = '04140b28';
const FD62_NATIVE = { baseIDoffset: 49, Sender_ID: 'ffcf27b1' };

/** A5 telegrams the gateway was asked to send, as hex of the radio data (R-ORG .. status) */
function sentA5(env) {
	return env.radio.filter((d) => d[0] === 0xa5).map((d) => d.toString('hex'));
}

/** time the gateway got the n-th A5 telegram (0-based) */
function sentTime(env, n) {
	const times = env.radio.map((d, i) => (d[0] === 0xa5 ? env.radioTimes[i] : null)).filter((t) => t !== null);
	return times[n];
}

async function start(env) {
	env.start();
	await env.waitConnected();
	await env.settle();
}

describe('sending a command', function () {
	allowTime(this);
	let env;
	afterEach(async () => {
		if (env) {
			await env.stop();
			env = null;
		}
	});

	it('sends after two database round trips, then acknowledges parameter and command', async () => {
		const L = 30;
		env = new TestEnv();
		env.addDevice(RGBW, ['TF-13-21'], RGBW_NATIVE);
		await start(env);
		await env.write(`${RGBW}.ROUT`, 1023);
		await env.settle();
		// from here on like js-controller 7.2.5 on the Pi: every database call is a round trip, setState reads the
		// object twice and the old state once before it writes
		env.latencyMs = L;
		env.objectReadsPerSetState = 2;
		env.stateReadsPerSetState = 1;
		const writes0 = env.writes.length;
		const calls0 = env.calls.length;

		await env.write(`${RGBW}.CMD`, 0); // the adapter gets the change right after the write
		const t0 = Date.now();
		await env.waitFor(() => sentA5(env).length === 1, 3000, 'telegram');
		const sent = sentTime(env, 0) - t0;
		await env.waitFor(() => env.states[`enocean.0.${RGBW}.CMD`].ack === true, 3000, 'command acknowledged');
		await env.settle();

		assert.deepEqual(sentA5(env), [R_FULL_RGBW]);
		// device object and parameter state: 2 round trips. Before, also the acknowledgement of the parameter (4) and
		// the gateway object (1), then up to 50 ms until the next turn of the send loop.
		assert.ok(sent < 4 * L, `sent after ${sent} ms, expected about ${2 * L}`);
		assert.ok(sent >= 1.5 * L, `latency model active (${sent} ms)`);
		const later = env.writes.slice(writes0);
		const rout = later.findIndex((w) => w.id === `enocean.0.${RGBW}.ROUT` && w.ack === true);
		const cmd = later.findIndex((w) => w.id === `enocean.0.${RGBW}.CMD` && w.ack === true);
		assert.ok(rout >= 0, 'parameter acknowledged');
		assert.ok(cmd > rout, 'command acknowledged after the parameter');
		assert.equal(env.states[`enocean.0.${RGBW}.ROUT`].val, 1023, 'value unchanged');
		assert.ok(
			!env.calls.slice(calls0).some((c) => c.op === 'getObject' && c.id === 'enocean.0.gateway'),
			'no gateway object read for a device with own sender ID',
		);
		assert.equal(env.logs.error.length, 0, env.logs.error.join(' | '));
	});

	it('sends at once when the gateway is idle, and keeps the gap to the telegram before', async () => {
		env = new TestEnv();
		env.addDevice(RGBW, ['TF-13-21'], RGBW_NATIVE);
		env.addDevice(SLAVE, ['TF-13-21'], SLAVE_NATIVE);
		await start(env);
		await env.write(`${RGBW}.ROUT`, 1023);
		await env.write(`${SLAVE}.ROUT`, 1023);
		await env.settle();
		// a long send interval, and a turn of the send loop right now: its next turn is a whole interval away
		env.adapter.sendIntervalMs = 300;
		await env.adapter.sendQueue();

		const t0 = Date.now();
		await env.write(`${RGBW}.CMD`, 0);
		await env.waitFor(() => sentA5(env).length === 1, 3000, 'first telegram');
		const first = sentTime(env, 0) - t0;
		assert.ok(first < 100, `first telegram after ${first} ms, not at the next turn of the send loop`);

		await env.write(`${SLAVE}.CMD`, 0);
		await env.waitFor(() => sentA5(env).length === 2, 3000, 'second telegram');
		assert.deepEqual(sentA5(env), [R_FULL_RGBW, R_FULL_SLAVE]);
		const gap = sentTime(env, 1) - sentTime(env, 0);
		assert.ok(gap >= 300 - 5, `gap between the telegrams ${gap} ms, expected the send interval (300 ms)`);
	});

	it('does not send a telegram twice when kicked while sending', async () => {
		env = new TestEnv();
		await start(env);
		const adapter = env.adapter;
		adapter.sendIntervalMs = 200;
		await adapter.sendQueue();
		const entry = (sender) => ({
			data: [0xa5, 0x03, 0xff, 0x10, 0x0f, ...Buffer.from(sender, 'hex'), 0x00],
			optionaldata: [0x00, 0xff, 0xb2, 0xfd, 0x86, 0xff, 0x00],
			packettype: 0x01,
			ts: performance.now(),
		});
		adapter.queue.push(entry('ffcf27b1'), entry('ffcf27c9'));

		adapter.kickSendQueue(); // sends the first; the loop is busy until sendData returns
		adapter.kickSendQueue(); // must neither send the first again nor the second right away
		await env.waitFor(() => sentA5(env).length === 2, 2000, 'both telegrams');
		await sleep(250);

		assert.deepEqual(sentA5(env), [R_FULL_RGBW, R_FULL_SLAVE]);
		assert.ok(sentTime(env, 1) - sentTime(env, 0) >= 200 - 5, 'second one after the send interval');
	});

	it('reads the base ID of the gateway for a device without own sender ID', async () => {
		env = new TestEnv();
		env.addDevice(PLAIN, ['TF-13-21']);
		await start(env);
		await env.write(`${PLAIN}.ROUT`, 1023);
		await env.settle();
		const calls0 = env.calls.length;

		await env.write(`${PLAIN}.CMD`, 0);
		await env.waitFor(() => sentA5(env).length === 1, 2000, 'telegram');
		await env.settle();

		assert.deepEqual(sentA5(env), ['a503ff100fffcf278000']);
		assert.ok(env.calls.slice(calls0).some((c) => c.op === 'getObject' && c.id === 'enocean.0.gateway'));
		assert.equal(env.states[`enocean.0.${PLAIN}.ROUT`].ack, true);
		assert.equal(env.logs.error.length, 0, env.logs.error.join(' | '));
	});

	it('acknowledges every parameter of a command, the command last', async () => {
		env = new TestEnv();
		env.addDevice(FD62, ['TF-13-07', 'TF-13-06'], FD62_NATIVE);
		await start(env);
		await env.write(`${FD62}.LVL`, 40);
		await env.write(`${FD62}.DS`, 5);
		await env.settle();
		const writes0 = env.writes.length;

		await env.write(`${FD62}.CMD`, 2);
		await env.waitFor(() => env.states[`enocean.0.${FD62}.CMD`].ack === true, 2000, 'command acknowledged');
		await env.settle();

		assert.deepEqual(sentA5(env), ['a502280509ffcf27b100']);
		const later = env.writes.slice(writes0);
		const acked = (name) => later.findIndex((w) => w.id === `enocean.0.${FD62}.${name}` && w.ack === true);
		assert.ok(acked('LVL') >= 0 && acked('DS') >= 0, 'both parameters acknowledged');
		assert.ok(acked('CMD') > acked('LVL') && acked('CMD') > acked('DS'), 'command after its parameters');
		assert.equal(env.states[`enocean.0.${FD62}.LVL`].val, 40);
		assert.equal(env.states[`enocean.0.${FD62}.DS`].val, 5);
	});

	it('acknowledges the other parameter and the command when one acknowledgement fails', async () => {
		env = new TestEnv();
		env.addDevice(FD62, ['TF-13-07', 'TF-13-06'], FD62_NATIVE);
		await start(env);
		await env.write(`${FD62}.LVL`, 40);
		await env.write(`${FD62}.DS`, 5);
		await env.settle();
		env.failOnce('setState', new RegExp(`^enocean\\.0\\.${FD62}\\.LVL$`), 'LVL write failed');

		await env.write(`${FD62}.CMD`, 2);
		await env.waitFor(() => env.logs.error.length > 0, 2000, 'error logged');
		await env.settle();

		assert.deepEqual(sentA5(env), ['a502280509ffcf27b100'], 'the telegram went out');
		assert.equal(env.states[`enocean.0.${FD62}.DS`].ack, true);
		assert.equal(env.states[`enocean.0.${FD62}.CMD`].ack, true);
		assert.equal(env.logs.error.length, 1, env.logs.error.join(' | '));
		assert.match(env.logs.error[0], /LVL write failed/);
		assert.equal(env.unhandled.length, 0);

		// both the parameter and the command fail: the error of the parameter is the one reported
		env.failOnce('setState', new RegExp(`^enocean\\.0\\.${FD62}\\.LVL$`), 'LVL write failed again');
		await env.write(`${FD62}.CMD`, 2);
		env.failOnce('setState', new RegExp(`^enocean\\.0\\.${FD62}\\.CMD$`), 'CMD write failed');
		await env.waitFor(() => env.logs.error.length > 1, 2000, 'second error logged');
		await env.settle();
		assert.equal(env.logs.error.length, 2, env.logs.error.join(' | '));
		assert.match(env.logs.error[1], /LVL write failed again/);
		assert.equal(env.unhandled.length, 0);
	});

	it('writes the acknowledgements of all parameters at the same time', async () => {
		const L = 30;
		env = new TestEnv();
		env.addDevice(FD62, ['TF-13-07', 'TF-13-06'], FD62_NATIVE);
		await start(env);
		await env.write(`${FD62}.LVL`, 40);
		await env.write(`${FD62}.DS`, 5);
		await env.settle();
		env.latencyMs = L;
		env.objectReadsPerSetState = 2;
		env.stateReadsPerSetState = 1;

		await env.write(`${FD62}.CMD`, 2);
		await env.waitFor(() => env.states[`enocean.0.${FD62}.CMD`].ack === true, 5000, 'command acknowledged');
		const sent = sentTime(env, 0);
		const ackedAt = (name) => {
			const w = env.writes.find((x) => x.id === `enocean.0.${FD62}.${name}` && x.ack === true && env.t0 + x.t >= sent);
			return w ? env.t0 + w.t - sent : null;
		};
		// each acknowledgement is a setState of 4 round trips; at the same time both are done after 4, one after
		// the other the second after 8; the command follows
		assert.ok(ackedAt('LVL') < 6 * L && ackedAt('DS') < 6 * L, `LVL after ${ackedAt('LVL')} ms, DS after ${ackedAt('DS')} ms`);
		assert.ok(ackedAt('CMD') > ackedAt('LVL') && ackedAt('CMD') > ackedAt('DS'), 'command after its parameters');
	});

	it('TCP (ser2net): a command during the start-up of the gateway waits until it is done', async () => {
		// gateway on a TCP socket: answers like the USB emulation, slowly (the start-up takes some 0.3 s)
		const packets = [];
		let socket = null;
		let envRef = null;
		const server = net.createServer((s) => {
			socket = s;
			const port = { isOpen: true, inject: (buf) => !s.destroyed && s.write(buf) };
			let buf = Buffer.alloc(0);
			s.on('data', (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				while (buf.length >= 6 && buf[0] === 0x55) {
					const total = 7 + buf.readUInt16BE(1) + buf[3];
					if (buf.length < total) {
						break;
					}
					const packet = buf.slice(0, total);
					buf = buf.slice(total);
					packets.push(`${packet[4]}:${packet[6].toString(16)}`);
					envRef.gatewayAnswer(port, packet);
				}
			});
			s.on('error', () => {});
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		// main.js pipes the TCP stream to stdout (old code); keep the binary data out of the test output (the Node
		// test runner talks to its parent over stdout)
		const pipe = net.Socket.prototype.pipe;
		net.Socket.prototype.pipe = function (dest, options) {
			return dest === process.stdout ? dest : pipe.call(this, dest, options);
		};
		try {
			env = envRef = new TestEnv({
				config: { ser2net: true, 'ser2net-ip': '127.0.0.1', 'ser2net-port': server.address().port, serialport: '' },
			});
			env.addDevice(RGBW, ['TF-13-21'], RGBW_NATIVE);
			env.answerDelayMs = 60;
			env.start();
			await env.waitFor(() => packets.length >= 1, 3000, 'first start-up command');
			await env.write(`${RGBW}.ROUT`, 1023);
			await env.write(`${RGBW}.CMD`, 0);
			await env.waitFor(() => packets.some((p) => p.startsWith('1:')), 5000, 'radio telegram');

			assert.deepEqual(packets, ['5:3', '5:a', '5:25', '5:8', '6:6', '1:a5']);
		} finally {
			net.Socket.prototype.pipe = pipe;
			// the adapter would reconnect (after 60 s) when the socket closes, also after unload (old code)
			if (envRef && envRef.adapter) {
				envRef.adapter.reconnectTCP = async () => {};
				await envRef.stop();
				env = null;
			}
			if (socket) {
				socket.destroy();
			}
			server.close();
		}
	});
});
