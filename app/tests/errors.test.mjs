/* errors.js: the text of anything thrown, and which engine answers are failures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText, engineAnswer } from '../ui/host/errors.js';

test('an Error gives its message, anything else itself', () => {
	assert.equal(errorText(new Error('boom')), 'boom');
	assert.equal(errorText('Not connected to host'), 'Not connected to host');
	assert.equal(errorText(null), 'null');
	assert.equal(errorText({ message: '' }), '[object Object]');
});

test('only a lone error string is an engine failure', () => {
	assert.throws(() => engineAnswer('{"error":"NotFound: no such commit"}'), { message: 'NotFound: no such commit' });
	assert.deepEqual(engineAnswer('{"commits":[],"error":null}'), { commits: [], error: null });
	assert.deepEqual(engineAnswer('{"error":null}'), { error: null });
	assert.deepEqual(engineAnswer('{"error":"partly","commits":[]}'), { error: 'partly', commits: [] });
	assert.deepEqual(engineAnswer('["error"]'), ['error']);
	assert.equal(engineAnswer('null'), null);
	assert.equal(engineAnswer('"1.0.28"'), '1.0.28');
});
