import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./modules/wake-ping/index.js', () => ({
  buildWakePingText: () => '[wake-ping] test ping',
}));

const mockIsContainerRunning = vi.fn<(id: string) => boolean>();
const mockKillContainer = vi.fn<(id: string, reason: string, onExit?: () => void) => void>();
const mockWakeContainer = vi.fn();
vi.mock('./container-runner.js', () => ({
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(args[0] as string),
  killContainer: (...args: unknown[]) =>
    mockKillContainer(args[0] as string, args[1] as string, args[2] as (() => void) | undefined),
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
}));

const mockGetSessionsByAgentGroup = vi.fn();
const mockGetSession = vi.fn();
vi.mock('./db/sessions.js', () => ({
  getSessionsByAgentGroup: (...args: unknown[]) => mockGetSessionsByAgentGroup(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockWriteSessionMessage = vi.fn();
vi.mock('./session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
}));

import { restartAgentGroupContainers } from './container-restart.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Helpers ---

function makeSession(id: string, agentGroupId: string, status = 'active') {
  return { id, agent_group_id: agentGroupId, status };
}

// --- Tests ---

describe('restartAgentGroupContainers', () => {
  it('skips sessions without a running container', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(false);

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('skips non-active sessions', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1', 'closed')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('kills running containers and returns count', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockImplementation((id) => id === 's1');

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(1);
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    // Always passes an onExit callback now (wake-ping is always injected)
    expect(typeof mockKillContainer.mock.calls[0][2]).toBe('function');
  });

  it('always writes a wake-ping on_wake message even without wakeMessage', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    restartAgentGroupContainers('g1', 'test');

    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
    const [, , msg] = mockWriteSessionMessage.mock.calls[0];
    expect(msg.onWake).toBe(1);
    expect(JSON.parse(msg.content).text).toBe('[wake-ping] test ping');
    // Always passes an onExit callback
    expect(typeof mockKillContainer.mock.calls[0][2]).toBe('function');
  });

  it('writes wake-ping then custom on_wake message when wakeMessage is provided', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    // First message is the wake-ping, second is the custom message
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);
    const [ag1, sid1, msg1] = mockWriteSessionMessage.mock.calls[0];
    expect(ag1).toBe('g1');
    expect(sid1).toBe('s1');
    expect(msg1.onWake).toBe(1);
    expect(JSON.parse(msg1.content).text).toBe('[wake-ping] test ping');

    const [, , msg2] = mockWriteSessionMessage.mock.calls[1];
    expect(msg2.onWake).toBe(1);
    expect(JSON.parse(msg2.content).text).toBe('Resuming.');

    // Should pass an onExit callback to killContainer
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    const onExit = mockKillContainer.mock.calls[0][2];
    expect(typeof onExit).toBe('function');
  });

  it('onExit callback calls wakeContainer with refreshed session', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    const freshSession = makeSession('s1', 'g1');
    mockGetSession.mockReturnValue(freshSession);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    // Simulate container exit by calling the onExit callback
    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockGetSession).toHaveBeenCalledWith('s1');
    expect(mockWakeContainer).toHaveBeenCalledWith(freshSession);
  });

  it('onExit callback does not wake if session no longer exists', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    mockGetSession.mockReturnValue(undefined);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('handles multiple running sessions', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = restartAgentGroupContainers('g1', 'test', 'Config updated.');

    expect(count).toBe(2);
    expect(mockKillContainer).toHaveBeenCalledTimes(2);
    // 2 messages per session (wake-ping + custom)
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(4);

    // s1 gets both messages
    expect(mockWriteSessionMessage.mock.calls[0][1]).toBe('s1');
    expect(mockWriteSessionMessage.mock.calls[1][1]).toBe('s1');
    // s2 gets both messages
    expect(mockWriteSessionMessage.mock.calls[2][1]).toBe('s2');
    expect(mockWriteSessionMessage.mock.calls[3][1]).toBe('s2');
  });
});
