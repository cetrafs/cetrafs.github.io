---
weight: 510
title: "fsck.cetra"
description: "Check and repair a cetrafs volume: synopsis, offline and live checks, the four passes, what -r repairs and refuses, and exit codes."
toc: true
---

## Synopsis

```text
fsck.cetra [-r] <blockdev>
fsck.cetra --live <blockdev>
fsck.cetra --discard-journal <row> <blockdev>
```

| Option | Meaning |
|---|---|
| *(none)* | Check only, offline. Changes nothing. |
| `-r`, `--repair` | Check offline and repair the faults that have one correct answer. Refuses everything else. |
| `--live` | Check a volume that other nodes have mounted, read-only, without claiming it. Can't be combined with `-r`. |
| `--discard-journal <row>` | Mark Node Registry row `<row>`'s journal clean **without replaying it**, then run as `-r`. Only for a journal a mount can't replay because a block of it is unreadable: its pending writes are lost, and the walk afterwards reports what they would have repaired. |

## Offline checks

`fsck.cetra` and `fsck.cetra -r` refuse to run if the volume is **mounted on this machine**, in any mount namespace, or if its Node Registry has a **live row**: a node that is still heartbeating. To tell, it watches every row a node hasn't left cleanly, for the longest stale window any row advertises (at most 240 s). A row whose heartbeat doesn't move counts as gone; the verdict never depends on comparing clocks.

## Live checks

`fsck.cetra --live <dev>` checks a volume while other nodes use it. It claims nothing and writes nothing, so the peers never notice it. Run it on a node that has the volume mounted, or on any other machine that sees the LUN; it first syncs this machine's mounts of the volume and reads the device directly, past the page cache.

The volume changes under the walk, so it walks up to three times:

| Result | Exit |
|---|---|
| A walk finds nothing | `0`, at once |
| Every walk reports the same problem, word for word | `1`: damage repeats, a peer's write in flight doesn't. Take the volume offline on every node and run `fsck.cetra -r`. |
| Every walk saw problems, but never the same one | `3`: the volume changed too fast to judge. Run it again when it is quieter. |

`--live` never repairs.

## Passes

| Pass | Checks |
|---|---|
| 1. Structural | Format version (`0x000A`) and feature bits; the superblock's checksum, fields and region map, and its copy at block 2048; the Block Group and inode table chains; Zone Group and Block Group descriptors against their headers; every Block Group owned by a real Zone Group or by none, with no two overlapping; Node Registry rows |
| 2. Cluster metadata | Per-node journals; pending-free queue entries, including a queued free for a block a file still uses |
| 3. Content | Every bitmap sector's checksum; the inode and data bitmaps against the extent trees, at every depth, in both directions; cross-file block overlap; two extents of one file over the same logical block; cached free counts against bitmaps; leaks |
| 4. Namespace | Every directory's entries and block tails; a directory's size against its entries; a directory with more than one name; `.` and `..`; link counts against referring entries; entry type against inode mode; reachability from the root |

## What `-r` repairs

| Fault | Repair |
|---|---|
| A bitmap bit disagreeing with the extent trees (leaked, or about to be allocated twice) | Bit set to match the trees |
| A bitmap sector that fails its checksum | Rewritten from the bits the extent trees settle on |
| A Block Group, Zone Group or pool free count disagreeing with the bitmaps | Recomputed |
| `nlink` disagreeing with the entries naming the inode | Corrected |
| An orphan inode with `nlink = 0`, or an empty file no entry names | Freed |
| An orphan inode with `nlink > 0` (a lost directory entry) | Linked into `/lost+found` as `#<ino>` |
| A directory's size disagreeing with its entries | Corrected |
| A directory block with a bad tail checksum whose entries all parse | Tail re-stamped, names kept |
| A regular file's extent leaf with a bad tail checksum | Salvaged: an entry is kept if its blocks are in a data region, set in the bitmap, named by nothing else, inside the index range and clear of the damaged sector. The rest become holes. |
| A damaged Zone Group record | Rebuilt |
| A damaged Block Group descriptor | Rebuilt from the Block Group's header |
| A damaged Node Registry row | Rebuilt, keeping the incarnation its claims carry |
| A garbage pending-free entry | Cleared |
| Block 0 that doesn't verify, with a good copy at block 2048 | The volume is checked through the copy, then block 0 is restored from it |
| A copy at block 2048 that is missing, stale or damaged | Rewritten |
| The "needs fsck" mark a node left after finding damage | Cleared, at the end of a pass that finds the volume clean |

`-r` also retires Node Registry rows of nodes that have left and that nothing references, so a volume that has seen many machines has room for new ones.

If `-r` reports reclaimed blocks, run it once more: some reclamation it enables is picked up on the next pass.

## What `-r` refuses

Reported, never changed:

| Fault | Why |
|---|---|
| Cross-file block overlap | Nothing on disk says which file should keep the block |
| An unreadable inode record or extent header | Its blocks can't be marked as used, so clearing them as leaks could hand a live file's blocks to someone else |
| A dangling directory entry | Removing it destroys a name |
| A directory with more than one name, or an extent tree no directory can have | Removing either name frees what the other still names. Either blocks every repair in the run. |
| A deleted file whose blocks another file now holds | Reviving it would give two files one block |
| Journal entries a mount hasn't replayed yet | The next mount completes those writes, which a repair made around them would contradict. No group record is rebuilt and the "needs fsck" mark stays. Mount the volume once, unmount it, and run `-r` again. |

## Messages that aren't damage

Leftovers of an interrupted operation are printed as `WARN` and don't change the exit code. Each is a leak, the safe direction, and the scrubber or `-r` takes it back: a deleted record's stale extents, a record that was never written, an empty file no entry names.

A Block Group or Zone Group free count behind its bitmap, in a Zone Group whose owner didn't leave cleanly, is printed as a `note:`. The mount that takes over or re-attaches that Zone Group recounts it.

After an unclean shutdown, an offline `fsck` run before the next mount can also report an orphan or a link count that lags its entries. The next mount repairs those; `fsck.cetra -r` isn't needed. A block referenced by a file but marked free is never a crash leftover: treat it as damage.

## While `-r` runs

A repair writes the inode table, the bitmaps and directory blocks, so nothing may mount the volume meanwhile. `fsck.cetra -r` **claims the volume** first: it holds a Node Registry row in the `REPAIR` state, and a mount on any node is refused with `EBUSY` until it ends. Other nodes show the row as `REPAIR-IN-PROGRESS` in [`cluster`](/docs/reference/procfs/#cluster).

- The claim is taken, renewed and released with compare-and-write, so two repairs started together can't both go ahead.
- It is a lease, renewed every few seconds. A repair whose renewal stalls stops writing.
- If a node starts heartbeating under the claim, the repair stops.
- Killed with `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGPIPE` or `SIGABRT`, it releases the claim. A claim left by `SIGKILL` or a crash is reaped by the next mount or tool, once it is no longer renewed.
- When the registry is full, a repair borrows the row of a node that has provably left, and gives it back.

A second `fsck.cetra -r` on a volume already being repaired stops with `is already being repaired` and exit code `3`. A check without `-r` takes no claim.

## Unknown feature bits

| The volume has an unknown | `fsck.cetra` | `fsck.cetra -r` |
|---|---|---|
| incompatible feature | refused, exit `1` | refused |
| read-only-compatible or compatible feature | warns and checks | refused, writes nothing, exit `3` |

## Exit status

| Code | Meaning |
|---|---|
| `0` | Clean |
| `1` | Problems found |
| `2` | Bad invocation |
| `3` | Couldn't examine the device, or `--live` couldn't reach a verdict |

## Notes

- Use an `fsck.cetra` from the same release as the kernel module. A tool from another format version refuses the volume.
- The volume's UUID is printed at the start of the run.
