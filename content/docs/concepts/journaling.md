---
weight: 425
title: "Journaling and crash consistency"
description: "The per-node write-ahead redo journal, why replay is safe on a peer's behalf, the replay guard, and what 'per-fsync, not per-syscall' means."
toc: true
---

## One journal per node

Each Node Registry row owns a private journal area. A node writes only to **its own** journal, so every journal has exactly one writer. (An earlier design had one journal per Zone Group and several possible writers per journal. It wasn't sound, and was replaced.)

The journal is a **physical redo log**. Each entry holds the complete new contents of one block, plus the checksum of what that block held before.

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

Because each entry is consumed within the operation that wrote it, an entry that survives means exactly one thing: **that node crashed in the middle of that operation.** A clean journal is flagged as such, so mounting after a clean shutdown skips the replay scan entirely, and mount time doesn't grow with journal or device size.

## Replay on a peer's behalf

Journals are replayed only at **ownership boundaries**:

- a node's own journal, when it mounts;
- a **stale** peer's journal, at the moment its Zone Group or lock is taken over;
- on a heartbeat sweep, for a crashed node that nothing else has needed to touch yet.

Each dead node's journal area is claimed by compare-and-write, so exactly one survivor replays it. Replay never runs as a blind sweep over a journal that a live node might still be writing.

## The replay guard

Originally, replay rewrote every surviving entry unconditionally. The reasoning was: the writer crashed while holding the operation's lock, so nobody else can have touched the target block. That reasoning **fails under `nofilelock`**, where extent-tree blocks have no cross-node lock. After an HA failover, the new host may already have rewritten a block that the dead host's journal still holds an older version of. Replaying that entry corrupted a VM image during deployment testing.

So replay now **checks before it applies**:

| The target block currently holds | Replay |
|---|---|
| What the entry says it held *before* the change | **Applies** the entry, finishing the interrupted write |
| The entry's payload already | **Skips** it: the write landed |
| A **torn** block, one that fails its own checksum | **Applies** the entry. The crash caught the write half-done, which is exactly what the journal is for. |
| Some other complete, valid block | **Refuses** it, and logs the block. Another node has rewritten it since, and rolling it back would destroy newer data. |

Entries for **freshly allocated** blocks are skipped outright, because nothing referenced them at crash time. The counters `journal_replay_applied`, `journal_replay_torn`, `journal_replay_skipped` and `journal_replay_refused` in `/proc/fs/cetrafs/<dev>/info` show which case happened. Each *refused* entry is a cross-node corruption that did not happen.

## Per-`fsync`, not per-syscall

The journal works **block by block**, not as a transaction. An operation such as creating a file touches several structures (the inode, its bitmap bit, the directory block), and they aren't committed as one atomic unit. The guarantee is therefore:

- **Data an application has acknowledged (`fsync` returned) is never lost.**
- After any crash, the volume **always mounts**, and **fsck can always repair it**.
- A crash in the middle of an operation that **hadn't been acknowledged** can leave a small remnant that fsck repairs: an orphan inode (its record reached the disk, its directory entry didn't), or a counter that has drifted.

`fsck.cetra -r` cleans these up. Orphans go to `/lost+found`, and bitmaps and counts are recomputed. This matches the guarantee VMFS makes. Making create and unlink fully atomic would need per-transaction journaling, a format-level change made only to provide semantics a VM-image workload doesn't use.

**After an unclean shutdown, expect `fsck.cetra -r` to find and fix a little residue. Expect no loss of data the guest had flushed.**

## Flushes on write-back storage

`fsync` and journal commits send a cache-flush to the block device, so a LUN with a volatile write-back cache is crash-safe. On a device with a battery-backed or non-volatile cache, those flushes cost nothing.
