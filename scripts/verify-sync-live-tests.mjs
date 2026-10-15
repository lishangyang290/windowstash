import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTarget } from './verify-sync-live.mjs';

test('live harness accepts only the dedicated test URL and publishable keys', () => {
  const target = 'https://vavfmwqxqcixbtyulhux.supabase.co';
  assert.doesNotThrow(() => validateTarget(target, 'sb_publishable_fake-test-key'));
  for (const url of [
    'https://mcstwafwotoduguxtlmb.supabase.co',
    `${target}.example.com`, `${target}/`, target.replace('https:', 'http:'),
  ]) assert.throws(() => validateTarget(url, 'sb_publishable_fake-test-key'));
  for (const key of ['', 'sb_secret_fake', 'service_role', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.throws(() => validateTarget(target, key));
  }
});
