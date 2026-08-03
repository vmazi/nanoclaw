import { describe, expect, it } from 'bun:test';

import { ClaudeProvider, describeTask, withLongContext } from './claude.js';

describe('ClaudeProvider.isSessionInvalid', () => {
  const provider = new ClaudeProvider();

  it('detects a missing or unknown transcript', () => {
    expect(provider.isSessionInvalid(new Error('No conversation found with session ID abc'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('ENOENT: no such file or directory, open /x/y.jsonl'))).toBe(true);
  });

  it('detects a transcript poisoned by an oversized image', () => {
    const err = new Error(
      'Claude Code returned an error result: An image in the conversation exceeds the dimension ' +
        'limit for many-image requests (2000px). Start a new session with fewer images.',
    );
    expect(provider.isSessionInvalid(err)).toBe(true);
  });

  it('leaves ordinary failures alone so the continuation survives', () => {
    expect(provider.isSessionInvalid(new Error('fetch failed'))).toBe(false);
    expect(provider.isSessionInvalid(new Error('Rate limit exceeded'))).toBe(false);
    expect(provider.isSessionInvalid(new Error('Bash tool timed out'))).toBe(false);
  });
});

describe('withLongContext', () => {
  it('opts models newer than Claude Code into the 1M window', () => {
    expect(withLongContext('claude-opus-5')).toBe('claude-opus-5[1m]');
    expect(withLongContext('claude-opus-4-8')).toBe('claude-opus-4-8[1m]');
    expect(withLongContext('claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]');
  });

  it('leaves models without a 1M window alone', () => {
    expect(withLongContext('claude-opus-4-5')).toBe('claude-opus-4-5');
    expect(withLongContext('claude-opus-4-1')).toBe('claude-opus-4-1');
    expect(withLongContext('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(withLongContext('claude-3-5-sonnet')).toBe('claude-3-5-sonnet');
  });

  it('is idempotent and passes through an unset model', () => {
    expect(withLongContext('claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    expect(withLongContext(undefined)).toBeUndefined();
  });
});

describe('describeTask', () => {
  it('passes a human summary straight through', () => {
    expect(describeTask('Re-bake and rebuild guide')).toBe('Re-bake and rebuild guide');
    expect(describeTask('Find near-duplicate syncro art')).toBe('Find near-duplicate syncro art');
  });

  it('replaces raw commands, which render as code snippets in chat', () => {
    expect(describeTask('timeout 1800 python3 bake_syncros.py --emit 2>&1 | tail -3')).toBe('still working');
    expect(describeTask("cat > /tmp/synshots.py <<'EOF'\nimport sys")).toBe('still working');
    expect(describeTask('cd /workspace/gba/rom && ls -la megabots.gba')).toBe('still working');
    expect(describeTask('python3 -c "')).toBe('still working');
  });

  it('says so when the task failed', () => {
    expect(describeTask('rm -rf /tmp/x', 'failed')).toBe('background task failed');
  });

  it('handles a missing summary', () => {
    expect(describeTask(undefined)).toBe('still working');
    expect(describeTask('   ')).toBe('still working');
  });
});
