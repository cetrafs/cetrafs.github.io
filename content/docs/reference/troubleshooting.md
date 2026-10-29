---
weight: 545
title: "Troubleshooting"
description: "Symptoms, error messages and counters, with what each one means and where to go next."
toc: true
---

## Errors from applications

| Symptom | Meaning | Next step |
|---|---|---|
| `Text file busy` (`ETXTBSY`) opening a file | Another live node has it open for writing (default mount), or holds it with `flock` | Expected. If the holder crashed, it clears after the stale window. |
| `Text file busy` deleting or renaming over a file | Another live node has the target open | Close it there first |
| qemu: `Could not open '…': Text file busy` during live migration | The cluster is mounted with the file lock on | [Enable live migration](/docs/how-tos/live-migration/) |
| Every write fails with `EIO` | This node has **fenced itself**: a peer took over its resources | Check `fenced: yes` in `info`, then unmount and mount again. [Details](/docs/how-tos/recover-node-failure/#a-mount-where-every-write-fails-with-eio) |
| `ENOSPC` with free space showing | No owned Zone Group has room and none is free to claim (`write_ready: no`), or the inodes have run out | Check `free_inodes` and `write_ready` |
| `EOPNOTSUPP` from `fallocate` | A mode other than allocate or punch-hole was requested | [Limits](/docs/reference/limits/#unsupported-operations) |
| `EOPNOTSUPP` from `flock` | Shared lock requested, or `LOCK_EX` on a default mount for a file this node doesn't have open for writing | Use `LOCK_EX`, on a descriptor opened for writing |
| `EWOULDBLOCK` from `flock -x -n` on a default mount | The lock was suspended and another node has taken the file since | Expected after a handoff. It never takes the lock from the peer: wait, or let the peer close the file |
| `EBUSY` from `flock -u` | The defragmenter is moving the file | Try again when the pass ends |
| `EINVAL` from `rename` | `RENAME_EXCHANGE` or `RENAME_WHITEOUT` | Not supported |

## Mount failures

| Symptom | Meaning | Next step |
|---|---|---|
| `EBUSY` | The device has no atomic CAW and another node already has it mounted | Single-node only. [Check CAW](/docs/how-tos/check-caw/). |
| `EINVAL`, version or feature in `dmesg` | The volume was made by a different format version | Reformat. [Upgrade](/docs/how-tos/upgrade-reformat/) |
| `EINVAL`, file-lock mode conflict in `dmesg` | Your `nofilelock` option disagrees with the mode the cluster already uses | Use the same options as the other nodes |
| "CAW discovery failed … refusing the mount" | cetrafs couldn't determine whether the device supports compare-and-write | Check the storage path; the probe will show the error |
| Mounted read-only unexpectedly | Unknown read-only-compatible feature bit | Tools and module are older than the volume |
| Mounts, but `write_ready: no` | Every Zone Group is owned by a live peer | Normal on a busy cluster; persistent means too few Zone Groups for the number of writers |
| `unknown filesystem type 'cetrafs'` | Module not installed for this kernel | `dkms status cetrafs`; install the headers for the running kernel |
| `insmod`: unknown symbol `crc32c` | CRC32C is a separate module on this kernel | `modprobe libcrc32c`, or install the module and use `modprobe` |

## Tool exit codes

| Tool | `3` means |
|---|---|
| `mkfs.cetra` | Device inaccessible, or **mounted locally or by a live peer**. `-f` won't override this. |
| `fsck.cetra` | Couldn't examine the device: inaccessible, mounted, or a live registry row (wait out the stale window after a crash) |

## Messages in fsck output

| Message | Meaning |
|---|---|
| `N data block(s) marked in use but referenced by no inode (leaked)` | Normal after a node crash: blocks reserved ahead of need. The scrubber reclaims them; `-r` does it at once. |
| Orphan inodes, drifted counts after an unclean shutdown | Leftovers from operations that weren't acknowledged (per-fsync consistency). `-r` repairs them. |
| Cross-file overlap, unreadable inode, dangling entry | `-r` refuses: these need a human decision. Keep the image, and report it. |

## Messages in the kernel log

| Message | Meaning |
|---|---|
| `BG N free delta … would take the count below zero`, repeated every heartbeat, with `surplus ZG release pass failed` | A 0.8.x bug: a stale free-count change was applied after a recount. Fixed in 0.9. Upgrade, then run `fsck.cetra -r` to recount. No file data is affected. |

## Counters worth a second look

| Counter (in `info`) | Concerning when |
|---|---|
| `journal_replay_refused` | It rises with no recent failover. Find the block in `dmesg`. |
| `cas_miscompares` | It stays at 0 while two nodes are both busy (they may not share the device) |
| `scrub_reclaimed` / `scrub_cycles` | Leaks keep growing across crashes and `scrub_cycles` doesn't move |
| `file_cache_drops` far above `file_cache_reconciles` | Files are stuck re-reading metadata from the device; I/O will be slow |
| `giveback_blocks` rising steadily | Extent splits are running out of room; usually a preallocated or heavily fragmented image |

## Performance

| Symptom | Likely cause |
|---|---|
| Guest much slower than the host | `aio=io_uring`, qcow2, or preallocation. [Configure VM disks](/docs/how-tos/configure-vm-disks/). |
| `dd if=/dev/zero` in the guest returns instantly, then stalls | qemu `detect_zeroes` is dropping the writes; not the filesystem |
| Creates and deletes take hundreds of milliseconds | Expected: synchronous metadata over device round trips. [Performance model](/docs/concepts/performance/). |
| A large copy gets slower as it goes | Check `bg_pick_scan` and `bg_desc_refreshed`; report it with those numbers |

## Getting more information

- `dmesg | grep cetrafs`: errors and warnings are always logged.
- [Turn on debug logging](/docs/how-tos/debug-logging/) for a full trace.
- `cat /proc/fs/cetrafs/*/{info,cluster,properties}` from every node.

{{< callout type="danger" >}}
Never `rmmod -f` cetrafs. A forced removal can leave a dangling entry in the kernel's memory-reclaim list that oopses the host on the next reclaim pass, and it persists until reboot. Unmount, then use plain `rmmod`.
{{< /callout >}}
