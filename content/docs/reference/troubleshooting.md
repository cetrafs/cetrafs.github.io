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
| `Text file busy` opening a file for writing, on a default mount | Another live node has it open for reading. Since 0.9.3 a file has one writer and nobody else, or readers and no writer | Close it on the reading node first |
| `Text file busy` deleting, renaming over, truncating or hole-punching a file | Another live node has the file open | Close it there first |
| qemu: `Could not open '…': Text file busy` during live migration | The cluster is mounted with the file lock on | [Enable live migration](/docs/how-tos/live-migration/) |
| Every access fails with `EIO` | The mount has **stopped**: fenced by a peer, its lease ran out, the device refused a metadata write, or someone stopped it | Check `fenced: yes` and `stopped:` in `info`, then unmount and mount again. [Details](/docs/how-tos/recover-node-failure/#a-mount-where-everything-fails-with-eio) |
| `Structure needs cleaning` (`EUCLEAN`) writing a file | Damaged metadata was found in it. Since 0.9.4 writes to it are refused; reads of its undamaged parts still work | Copy out what can be read, unmount everywhere, run `fsck.cetra -r`. [Details](/docs/how-tos/recover-node-failure/#a-file-that-returns-structure-needs-cleaning-euclean) |
| `EIO` from `close` | A write of the file's data failed earlier and nothing had reported it. Since 0.9.4 `close` does | Check the storage path; the data written since the last successful `fsync` may not be on the device |
| `EIO` from `flock -u` | The release didn't reach the device. Since 0.9.4 the descriptor then keeps the lock | Retry `flock -u`. A migration hook that ignores the result sees the destination's open fail with `ETXTBSY` |
| `ETXTBSY` writing a file after `flock -u` on a default mount | This node suspended its lock for a handoff. Since 0.9.4 its own writes are refused until `flock -x` takes the lock back (a store through `mmap` gets `SIGBUS`) | Expected: the handoff never has two writers |
| `ENOSPC` with free space showing | No owned Zone Group has room and none is free to claim (`write_ready: no`), or the inodes have run out | Check `free_inodes` and `write_ready` |
| `EOPNOTSUPP` from `fallocate` | A mode other than allocate or punch-hole was requested | [Limits](/docs/reference/limits/#unsupported-operations) |
| `EOPNOTSUPP` from `flock` | Shared lock requested, or `LOCK_EX` on a default mount for a file this node doesn't have open for writing | Use `LOCK_EX`, on a descriptor opened for writing |
| `EBADF` from `flock` | Since 0.9.5 `LOCK_EX` and `LOCK_UN` need a descriptor open for writing, or `CAP_SYS_ADMIN` | Open with `exec 9>>`, not `9<` |
| `EIO` on one node for files with blocks in space another node just grew into | This node's device still has the old size; `dmesg` says to rescan it. Nothing is marked damaged | [Rescan the device](/docs/how-tos/grow-volume/#2-make-every-node-see-the-larger-device) on this node |
| `EWOULDBLOCK` from `flock -x -n` on a default mount | The lock was suspended and another node has taken the file since | Expected after a handoff. It never takes the lock from the peer: wait, or let the peer close the file |
| `EBUSY` from `flock -u` | The defragmenter is moving the file | Try again when the pass ends |
| `EINVAL` from `fsync`, `fdatasync` or `close`, or qemu failing the first flush after a write | The device's logical block is 4 KiB (a 4Kn target), and the module is older than 0.9.1 | Upgrade to 0.9.1 or later. Nothing on the volume was damaged: the update failed instead of writing |
| `EINVAL` from `rename` | `RENAME_EXCHANGE` or `RENAME_WHITEOUT` | Not supported |

## Loading the module

| Symptom | Meaning | Next step |
|---|---|---|
| `modprobe`: `Key was rejected by service` | Secure Boot is enabled and the module's signing key isn't enrolled. Every DKMS-built module does this | [Enroll the DKMS key](/docs/how-tos/secure-boot/) on the node |
| `insmod`: `Required key not available` or `Key was rejected by service` | Secure Boot and a module you built yourself, which isn't signed | [Sign it](/docs/how-tos/secure-boot/#modules-you-build-yourself) |
| `unknown filesystem type 'cetrafs'` | The module isn't installed for this kernel, or the kernel refused to load it | `dkms status cetrafs`; install the headers for the running kernel. If it is installed, `modprobe cetrafs` shows why it won't load |
| `insmod`: unknown symbol `crc32c` | CRC32C is a separate module on this kernel | `modprobe libcrc32c`, or install the module and use `modprobe` |

## Mount failures

| Symptom | Meaning | Next step |
|---|---|---|
| `EBUSY` | The device has no atomic CAW and another node already has it mounted | Single-node only. [Check CAW](/docs/how-tos/check-caw/). |
| `EBUSY`, `is being repaired right now` in `dmesg` | An `fsck.cetra -r` or `growfs.cetra` is working on the volume | Wait for it to finish. If it is killed, it releases the claim on the way out; if it couldn't (`SIGKILL`, a crash), the next mount watches the claim for the stale window and goes ahead once it is no longer renewed. |
| `EBUSY`, `another machine has the same node UUID` in `dmesg` | Two machines share a DMI UUID, typically cloned VMs, and the other one has the volume mounted | Give one of them its own identity: `options cetrafs node_uuid=<uuid>`. See [the Node Registry](/docs/concepts/coordination/#the-node-registry). |
| Mount takes minutes, `watching it … to be sure no other machine is using it` in `dmesg` | The first mount after an unclean shutdown watches its old registry row for the stale window (120 s by default), and may wait for a peer replaying its journal | Expected. If systemd kills the mount after 90 s, raise its [mount timeout](/docs/how-tos/mount-volume/#mount-at-boot-with-etcfstab) |
| `EBUSY`, `is already mounted without …` in `dmesg` | A second mount of a device this node already has mounted asks for a `nofilelock`, `errors=` or `corruption=` setting the first mount doesn't have | Use the first mount's options |
| Refused, page size in `dmesg` | An arm64 kernel with 16 KiB or 64 KiB pages. Since 0.9.4 the page must be one 4 KiB block | Use a 4 KiB-page kernel |
| `EINVAL`, version or feature in `dmesg` | The volume was made by a different format version | Reformat. [Upgrade](/docs/how-tos/upgrade-reformat/) |
| `EINVAL`, file-lock mode conflict in `dmesg` | Your `nofilelock` option disagrees with the mode the cluster already uses | Use the same options as the other nodes |
| "CAW discovery failed … refusing the mount" | cetrafs couldn't determine whether the device supports compare-and-write | Check the storage path; the probe will show the error |
| Mounted read-only unexpectedly | Unknown read-only-compatible feature bit | Tools and module are older than the volume |
| Mounts, but `write_ready: no` | Every Zone Group is owned by a live peer | Normal on a busy cluster; persistent means too few Zone Groups for the number of writers |

## Tool exit codes

| Tool | `3` means |
|---|---|
| `mkfs.cetra` | Device inaccessible, or **mounted locally or by a live peer**. `-f` won't override this. |
| `fsck.cetra` | Couldn't examine the device: inaccessible, mounted, or a registry row that is still heartbeating |

## Messages in fsck output

| Message | Meaning |
|---|---|
| `N data block(s) marked in use but referenced by no inode (leaked)` | Normal after a node crash: blocks reserved ahead of need. The scrubber reclaims them; `-r` does it at once. |
| Orphan inodes, drifted counts after an unclean shutdown | Leftovers from operations that weren't acknowledged (per-fsync consistency). `-r` repairs them. |
| Cross-file overlap, unreadable inode, dangling entry | `-r` refuses: these need a human decision. Keep the image, and report it. |
| `WARN` lines about a deleted record's stale extents, a record never written, or an empty file no entry names | Since 0.9.4 these are leftovers of an interrupted operation, not damage, and don't change the exit code. Each is a leak; the scrubber or `-r` takes it back. |

## Messages in the kernel log

| Message | Meaning |
|---|---|
| `BG N free delta … would take the count below zero`, repeated every heartbeat, with `surplus ZG release pass failed` | A 0.8.x bug: a stale free-count change was applied after a recount. Fixed in 0.9. Run `fsck.cetra -r` to recount, and upgrade. No file data is affected. |

## Counters worth a second look

| Counter (in `info`) | Concerning when |
|---|---|
| `journal_replay_refused` | It rises with no recent failover. Find the block in `dmesg`. |
| `cas_miscompares` | It stays at 0 while two nodes are both busy (they may not share the device) |
| `scrub_reclaimed` / `scrub_cycles` | Leaks keep growing across crashes and `scrub_cycles` doesn't move |
| `scrub_inflight_skips` | Rises with every cycle and leaks never fall. Constant guest discards can do this; it only delays reclaim |
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
