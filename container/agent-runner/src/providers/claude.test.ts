import { describe, expect, it } from 'bun:test';

import { ClaudeProvider } from './claude.js';

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
