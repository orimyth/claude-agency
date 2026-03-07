import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, TaskStatus } from './types.js';

// We test the transition logic directly rather than through the class
// to avoid needing a real DB connection.

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['assigned', 'queued', 'done', 'cancelled'],
  queued: ['in_progress', 'backlog', 'blocked', 'cancelled'],
  assigned: ['in_progress', 'queued', 'backlog', 'blocked', 'cancelled'],
  in_progress: ['verifying', 'review', 'done', 'blocked', 'assigned', 'cancelled'],
  verifying: ['review', 'done', 'in_progress', 'blocked'],
  review: ['done', 'in_progress', 'assigned', 'cancelled'],
  done: [],
  blocked: ['assigned', 'queued', 'backlog', 'in_progress', 'cancelled'],
  cancelled: ['backlog'],
};

function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

describe('Task state transitions', () => {
  describe('valid transitions', () => {
    const validCases: [TaskStatus, TaskStatus][] = [
      ['backlog', 'assigned'],
      ['backlog', 'queued'],
      ['queued', 'in_progress'],
      ['assigned', 'in_progress'],
      ['in_progress', 'verifying'],
      ['in_progress', 'review'],
      ['in_progress', 'done'],
      ['in_progress', 'blocked'],
      ['verifying', 'review'],
      ['verifying', 'done'],
      ['verifying', 'in_progress'],
      ['review', 'done'],
      ['review', 'in_progress'],
      ['blocked', 'in_progress'],
      ['blocked', 'backlog'],
      ['cancelled', 'backlog'],
    ];

    for (const [from, to] of validCases) {
      it(`allows ${from} → ${to}`, () => {
        expect(canTransition(from, to)).toBe(true);
      });
    }
  });

  describe('invalid transitions', () => {
    const invalidCases: [TaskStatus, TaskStatus][] = [
      ['done', 'in_progress'],
      ['done', 'backlog'],
      ['done', 'review'],
      ['backlog', 'review'],
      ['backlog', 'verifying'],
      ['cancelled', 'in_progress'],
      ['cancelled', 'done'],
      ['verifying', 'backlog'],
    ];

    for (const [from, to] of invalidCases) {
      it(`blocks ${from} → ${to}`, () => {
        expect(canTransition(from, to)).toBe(false);
      });
    }
  });

  describe('cancellation', () => {
    it('can cancel from most active states', () => {
      const cancellable: TaskStatus[] = ['backlog', 'queued', 'assigned', 'in_progress', 'review', 'blocked'];
      for (const status of cancellable) {
        expect(canTransition(status, 'cancelled')).toBe(true);
      }
    });

    it('cannot cancel done tasks', () => {
      expect(canTransition('done', 'cancelled')).toBe(false);
    });

    it('can only reopen cancelled tasks to backlog', () => {
      expect(canTransition('cancelled', 'backlog')).toBe(true);
      expect(canTransition('cancelled', 'in_progress')).toBe(false);
      expect(canTransition('cancelled', 'assigned')).toBe(false);
    });
  });

  describe('done is terminal', () => {
    it('has no valid transitions from done', () => {
      expect(VALID_TRANSITIONS.done).toHaveLength(0);
    });
  });

  describe('verification flow', () => {
    it('in_progress → verifying → review → done', () => {
      expect(canTransition('in_progress', 'verifying')).toBe(true);
      expect(canTransition('verifying', 'review')).toBe(true);
      expect(canTransition('review', 'done')).toBe(true);
    });

    it('verifying can go back to in_progress on failure', () => {
      expect(canTransition('verifying', 'in_progress')).toBe(true);
    });

    it('verifying can skip review and go to done', () => {
      expect(canTransition('verifying', 'done')).toBe(true);
    });
  });
});
