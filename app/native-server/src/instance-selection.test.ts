import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  clearSelection,
  listInstances,
  resolveSessionHost,
  selectInstance,
  type InstanceDirectory,
} from './instance-selection.js';
import type { NativeMessagingHost } from './native-messaging-host.js';

const stable = {
  instanceId: 'aaaaaaaa-1111-4111-8111-111111111111',
  label: 'Work',
  browser: 'Chrome/143',
  protocolVersion: 2,
  extensionVersion: '1.0.0',
  connectedAt: '2026-10-14T00:00:00.000Z',
};
const canary = { ...stable, instanceId: 'bbbbbbbb-2222-4222-8222-222222222222', label: 'Personal' };
const duplicate = { ...stable, instanceId: 'cccccccc-3333-4333-8333-333333333333' };

const hosts = new Map<string, NativeMessagingHost>();
let present: (typeof stable)[] = [];

const directory: InstanceDirectory = {
  instances: () => present,
  // The real registry deletes the entry on detach, so a host is only reachable
  // while its instance is present. Modelling that is the point of this fixture.
  hostFor: (id) =>
    present.some((instance) => instance.instanceId === id) ? (hosts.get(id) ?? null) : null,
  soleHost: () => (present.length === 1 ? (hosts.get(present[0].instanceId) ?? null) : null),
};

beforeEach(() => {
  hosts.clear();
  for (const instance of [stable, canary, duplicate]) {
    hosts.set(instance.instanceId, { id: instance.instanceId } as unknown as NativeMessagingHost);
  }
  present = [stable, canary];
  for (const session of ['s1', 's2']) clearSelection(session);
});

describe('instance selection', () => {
  test('binds by label and by id prefix', () => {
    expect(selectInstance(directory, 's1', 'Work').instanceId).toBe(stable.instanceId);
    expect(selectInstance(directory, 's1', 'bbbbbbbb').instanceId).toBe(canary.instanceId);
  });

  test('two sessions hold independent selections', () => {
    selectInstance(directory, 's1', 'Work');
    selectInstance(directory, 's2', 'Personal');

    expect(resolveSessionHost(directory, 's1')).toBe(hosts.get(stable.instanceId));
    expect(resolveSessionHost(directory, 's2')).toBe(hosts.get(canary.instanceId));
  });

  test('a duplicate label is an error, not a guess', () => {
    present = [stable, duplicate]; // both labelled "Work"
    expect(() => selectInstance(directory, 's1', 'Work')).toThrow(/more than one browser/);
    // Resolvable by prefix, which is the documented way out.
    expect(selectInstance(directory, 's1', 'cccccccc').instanceId).toBe(duplicate.instanceId);
  });

  test('an unknown selector lists what is connected', () => {
    expect(() => selectInstance(directory, 's1', 'nope')).toThrow(/Work.*Personal/s);
  });

  test('an unbound session resolves only while unambiguous', () => {
    present = [stable];
    expect(resolveSessionHost(directory, 's1')).toBe(hosts.get(stable.instanceId));

    present = [stable, canary];
    expect(() => resolveSessionHost(directory, 's1')).toThrow(/More than one browser/);
  });

  test('a bound browser going away is an error, never a silent re-point', () => {
    selectInstance(directory, 's1', 'Personal');
    present = [stable];

    // Falling back to the survivor here is the failure that would outlive all of
    // this work: an agent clicking in the wrong profile and never being told.
    expect(() => resolveSessionHost(directory, 's1')).toThrow(/no longer connected/);
  });

  test('the listing marks which browser this session drives', () => {
    selectInstance(directory, 's1', 'Work');
    const listed = listInstances(directory, 's1');
    expect(listed.map((i) => [i.label, i.selected])).toEqual([
      ['Work', true],
      ['Personal', false],
    ]);
    expect(listInstances(directory, 's2').every((i) => !i.selected)).toBe(true);
  });
});
