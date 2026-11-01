import { test } from "node:test";
import assert from "node:assert/strict";
import { folderSyncState, type FolderSyncInput } from "../lib/sync/replica-state.ts";

const GB = 1e9;
const base = (o: Partial<FolderSyncInput> = {}): FolderSyncInput => ({
  agentOnline: true,
  local: { paused: false, state: "idle", globalBytes: 3.6 * GB, globalItems: 420, localBytes: 3.6 * GB, needItems: 0, needBytes: 0 },
  remote: { connected: true, paused: false, completion: 100, needItems: 0, needBytes: 0, globalBytes: 3.6 * GB, globalItems: 420 },
  hostFolderPaused: false,
  hold: { paused: false, reason: null },
  hostName: "arm-free",
  replicaName: "laptop",
  ...o,
});

test("folderSyncState: replica's own view says up to date even when arm-free cannot report completion", () => {
  // The reported bug: arm-free's completion call failed (folder paused there / API error) and became 0%.
  const r = folderSyncState(base({ remote: { connected: true, completion: null, needItems: 0, needBytes: 0, completionError: "500" } }));
  assert.equal(r.state, "up-to-date");
  assert.equal(r.completion, 100);
  assert.equal(r.detail.source, "replica");
});

test("folderSyncState: paused by the schedule is 'paused' with the reason, never 0%", () => {
  const r = folderSyncState(base({
    local: { paused: true, state: "paused", globalBytes: 3.6 * GB, localBytes: 3.6 * GB, needItems: 0, needBytes: 0 },
    hostFolderPaused: true,
    remote: { connected: true, completion: null, needItems: 0, needBytes: 0, completionError: "folder paused on this device" },
    hold: { paused: true, reason: "schedule" },
  }));
  assert.equal(r.state, "paused");
  assert.match(r.reason ?? "", /paused by the sync schedule/);
  assert.equal(r.completion, 100);
  assert.equal(r.detail.pauseReason, "paused by the sync schedule");
});

test("folderSyncState: paused device (arm-free paused the replica in its Syncthing)", () => {
  const r = folderSyncState(base({ local: null, remote: { connected: false, paused: true, completion: null, needItems: 0, needBytes: 0 } }));
  assert.equal(r.state, "paused");
  assert.match(r.reason ?? "", /laptop is paused in arm-free's Syncthing/);
  assert.notEqual(r.completion, 0);
});

test("folderSyncState: manual pause names the user", () => {
  const r = folderSyncState(base({ hostFolderPaused: true, hold: { paused: true, reason: "manual" } }));
  assert.equal(r.state, "paused");
  assert.match(r.reason ?? "", /by you/);
});

test("folderSyncState: disconnected peer is 'peer-offline'", () => {
  const r = folderSyncState(base({ remote: { connected: false, completion: 100, needItems: 0, needBytes: 0 } }));
  assert.equal(r.state, "peer-offline");
  assert.match(r.reason ?? "", /not connected to arm-free.*up to date at last contact/);
  const noLocal = folderSyncState(base({ local: null, remote: { connected: false, completion: 87, needItems: 3, needBytes: 10 } }));
  assert.equal(noLocal.state, "peer-offline");
  assert.equal(noLocal.completion, 87);
});

test("folderSyncState: global size 0 is 'nothing-to-sync' (empty dumps folder)", () => {
  const r = folderSyncState(base({ local: { paused: false, state: "idle", globalBytes: 0, globalItems: 0, localBytes: 0, needItems: 0, needBytes: 0 } }));
  assert.equal(r.state, "nothing-to-sync");
  assert.equal(r.completion, null);
  const remoteOnly = folderSyncState(base({ local: null, remote: { connected: true, completion: 100, needItems: 0, needBytes: 0, globalBytes: 0, globalItems: 0 } }));
  assert.equal(remoteOnly.state, "nothing-to-sync");
});

test("folderSyncState: real syncing reports percent from bytes", () => {
  const r = folderSyncState(base({ local: { paused: false, state: "syncing", globalBytes: 1000, localBytes: 750, needItems: 4, needBytes: 250 } }));
  assert.equal(r.state, "syncing");
  assert.equal(r.completion, 75);
  assert.equal(r.needItems, 4);
});

test("folderSyncState: completion unknown with no local view is 'unknown', not 0%", () => {
  const r = folderSyncState(base({ local: null, remote: { connected: true, completion: null, needItems: 0, needBytes: 0, completionError: "boom" } }));
  assert.equal(r.state, "unknown");
  assert.equal(r.completion, null);
  assert.match(r.reason ?? "", /boom/);
});

test("folderSyncState: agent offline and folder error", () => {
  assert.equal(folderSyncState(base({ agentOnline: false })).state, "offline");
  assert.equal(folderSyncState(base({ local: { paused: false, state: "error", globalBytes: 1, localBytes: 0, needItems: 1, needBytes: 1 } })).state, "error");
});
