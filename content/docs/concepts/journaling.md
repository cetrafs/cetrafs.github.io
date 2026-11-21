---
weight: 425
title: "Journaling and crash consistency"
description: "The per-node write-ahead redo journal, why replay is safe on a peer's behalf, the replay guard, and why a crash needs no fsck."
toc: true
---

## One journal per node

Each Node Registry row owns a private journal area. A node writes only to **its own** journal, so every journal has exactly one writer. (An earlier design had one journal per Zone Group and several possible writers per journal. It wasn't sound, and was replaced.)

The journal is a **physical redo log**. Each entry holds the complete new contents of one block, the checksum of what that block held before, and the inode the block belongs to.

## What gets journaled

Only blocks that live in Block Group data regions and are changed in place:

- directory blocks,
- extended-attribute blocks,
- extent-tree leaf and interior blocks.

The global tables (inodes, registry rows, Zone Group descriptors, bitmaps) aren't journaled. They are protected by compare-and-write, by one-record-per-block layout, and by [fsck's](/docs/how-tos/check-and-repair/) ability to rebuild derived state.

## Write-ahead, then consume

Writing a journaled block goes like this:

1. Write the new contents (the payload) to a journal slot, together with a header that acts as the commit marker. Both go out in one batch and are flushed to stable storage.
2. Perform the real write in place.
3. **Consume** the entry immediately by zeroing its header.

A regular file's extent-tree blocks are the exception to step 3. They are held back in memory and written as one journal batch at `fsync` or close, after the data and bitmap bits they name are on stable storage, and that batch's entries are retired by the next batch. So a surviving entry means either a crash in the middle of an operation, or a batch that completed just before the crash. Replay doesn't need to tell the two apart: it judges every entry against the block on the device, as below.

A clean journal is flagged as such, so mounting after a clean shutdown skips the replay scan entirely, and mount time doesn't grow with journal or device size.

## Replay on a peer's behalf

Journals are replayed only at **ownership boundaries**:

- a node's own journal, when it mounts;
- a **stale** peer's journal, at the moment its Zone Group or lock is taken over;
- on a heartbeat sweep, for a crashed node that nothing else has needed to touch yet.

Each dead node's journal area is claimed by compare-and-write, so exactly one survivor replays it. Replay never runs as a blind sweep over a journal that a live node might still be writing.

Under `nofilelock`, an open of a file whose last writer died replays that writer's journal first. While the dead node is silent but not yet stale, the open is refused with `EAGAIN` rather than going ahead past unreplayed entries. An entry for a file that a live node already has open for writing is kept back, and blocks only that file, until it can be judged.

## The replay guard

Originally, replay rewrote every surviving entry unconditionally. The reasoning was: the writer crashed while holding the operation's lock, so nobody else can have touched the target block. That reasoning **fails under `nofilelock`**, where extent-tree blocks have no cross-node lock. After an HA failover, the new host may already have rewritten a block that the dead host's journal still holds an older version of. Replaying that entry corrupted a VM image during deployment testing.

So replay now **checks before it applies**:

| The target block currently holds | Replay |
|---|---|
| What the entry says it held *before* the change | **Applies** the entry, finishing the interrupted write |
| The entry's payload already | **Skips** it: the write landed |
| A **torn** block, one that fails its own checksum | **Applies** the entry. The crash caught the write half-done, which is exactly what the journal is for. |
| Some other complete, valid block | **Refuses** it, and logs the block. Another node has rewritten it since, and rolling it back would destroy newer data. |

Two more checks come first. An entry whose owner inode no longer references the target block is refused: the block has moved on to another use. An entry from before the last time the area was parked clean is discarded. Entries for **freshly allocated** blocks are skipped outright, because nothing referenced them at crash time.

The counters `journal_replay_applied`, `journal_replay_torn`, `journal_replay_skipped`, `journal_replay_refused` and `journal_replay_kept` in `/proc/fs/cetrafs/<dev>/info` show which case happened. Each *refused* entry is a cross-node corruption that did not happen.

If a dead node's journal can't settle, because a block it names is unreadable or a host will never come back, an operator can [retire it](/docs/how-tos/recover-node-failure/#a-dead-nodes-journal-that-wont-settle): everything that can be redone is, and each entry given up is logged.

## Per-`fsync`, not per-syscall

The journal works **block by block**, not as a transaction. An operation such as creating a file touches several structures (the inode, its bitmap bit, the directory block), and they aren't committed as one atomic unit. The guarantee is therefore:

- **Data an application has acknowledged (`fsync` returned) is never lost.**
- After any crash, the volume **always mounts**, and **mounting it again repairs what the crash left**.
- A crash in the middle of an operation that **hadn't been acknowledged** can leave a small remnant: a new inode whose directory entry didn't land, a count that lags its entries, leaked blocks.

The namespace lock is what makes the remount enough. An operation holds the lock on every record it changes, and a create holds its new record's lock until the name lands. A crash leaves those locks set on the device, and whoever takes one over (the crashed node when it mounts again, a peer at its next operation on that directory, or the scrubber for a file no name reaches) recounts the records under it. Leaked blocks go back to the scrubber. A block referenced by a file but marked free, the dangerous case, never happens: the allocation bits are flushed before every record that names them.

A crash test measures this: it replays an unsynced workload of creates, writes, truncates, punches, preallocations and unlinks to every flush and a sample of the writes in between, and requires the remount to leave nothing behind at every cut. This matches the guarantee VMFS makes. Making create and unlink fully atomic would need per-transaction journaling, a format change bought only for semantics a VM-image workload doesn't use.

**An unclean shutdown doesn't call for `fsck.cetra -r`. Expect no loss of data the guest had flushed.**

## Flushes on write-back storage

`fsync`, journal commits, `sync`, `syncfs` and unmount send a cache flush to the block device, so a LUN with a volatile write-back cache is crash-safe. Every metadata update is ordered by a cache flush against the data it names and the free that follows it, not just by write completion: buffered writes leave their blocks marked unwritten until `fsync`, close or `sync` has the data on the device. On a device with a battery-backed or non-volatile cache, those flushes cost nothing.

The ordering relies on the array keeping its word: a flush must not be acknowledged before the data is safe. An array cache with no battery or mirror behind it, or a hypervisor layer that swallows flushes, breaks it silently. That is a property of the storage that no test on the host can check; [validate it](/docs/how-tos/validate-storage-stack/#l0-the-raw-lun) with a power cut.
