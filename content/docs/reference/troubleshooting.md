---
weight: 545
title: "Troubleshooting"
description: "Symptoms, error messages and counters, with what each one means and where to go next."
toc: true
---

## Errors from applications

| Symptom | Meaning | Next step |
|---|---|---|
| `Text file busy` (`ETXTBSY`) opening a file | Another live node has it open for writing (default mount), or holds it with `flock`. A file has one writer and nobody else, or readers and no writer. | Expected. Close it on the other node. |
| `Text file busy` opening a file a crashed node had open | The dead node's lock holds until the stale window passes (120 s by default) | Wait, or [declare the host dead](/docs/how-tos/recover-node-failure/#declare-a-fenced-host-dead) once it is powered off |
| `EAGAIN` opening a file on a `nofilelock` mount after a node died | The dead node's journal for that file hasn't been replayed yet | The same: wait for the stale window, or declare the host dead |
| `Text file busy` deleting, renaming over or truncating a file | Another live node has the file open | Close it there first |
| qemu: `Could not open '…': Text file busy` during live migration | The cluster is mounted with the file lock on | [Enable live migration](/docs/how-tos/live-migration/) |
| qemu: `Failed to lock byte …` | A stock qemu with image locking, on a default mount, where `fcntl` locks are refused | Mount that node with `localposixlocks`, or run the cluster `nofilelock`. See [`fcntl` locks](/docs/reference/mount-options/#fcntl-byte-range-locks). |
| `ENOLCK` from `fcntl` | Byte-range locks aren't cluster-wide, so a default mount refuses them | As above |
| Every access fails with `EIO` | The mount has **stopped** | Check `fenced` and `stopped` in `info`, then unmount and mount again. [Details](/docs/how-tos/recover-node-failure/#a-mount-where-everything-fails-with-eio) |
| `Structure needs cleaning` (`EUCLEAN`) writing a file | Damaged metadata was found in it. Writes to it are refused; reads of its undamaged parts still work | Copy out what can be read, then run `fsck.cetra -r` offline. [Details](/docs/how-tos/recover-node-failure/#a-file-that-returns-structure-needs-cleaning-euclean) |
| `ENOSPC` on one node while `df` on another shows free space | A node allocates only from Block Groups it owns or nobody owns, and never takes space from a live peer | Compare `free_data_blocks_owned` and `free_data_blocks_unowned_bgs` in `info` on each node. Move the VM to a node with space, or grow the volume. See [Limits](/docs/reference/limits/#operational-characteristics). |
| `ENOSPC` writing one file, with the volume far from full | The file's extent tree is full: millions of small scattered first writes | `dmesg` names the file. Copy it to lay it out again. See [extents per file](/docs/reference/limits/#extents-per-file). |
| `ENOSPC` creating a file in one directory | The directory has reached about 3.9 million entries | `dmesg` names the directory. Spread files across directories. |
| `ENOSPC` everywhere | The volume or its inodes are full | Check `free_data_blocks` and `free_inodes`; [grow the volume](/docs/how-tos/grow-volume/), with `-N` for inodes |
| Writes hang, processes in `D` state, `has no space to overwrite … waiting for it` in `dmesg` | The array's thin pool is full, or a snapshot has no room for its copy-on-write | Give the pool space or delete a snapshot; the writes complete on their own. See [When the array runs out of space](/docs/reference/mount-options/#when-the-array-runs-out-of-space). |
| `EOPNOTSUPP` from `fallocate` | `COLLAPSE_RANGE` or `INSERT_RANGE`; or preallocation on a file another node has open | Expected; qemu and `posix_fallocate` fall back |
| `EOPNOTSUPP` from `flock` | Shared lock requested, or `LOCK_EX` on a default mount for a file this node doesn't have open for writing | Use `LOCK_EX`, on a descriptor opened for writing |
| `EBADF` from `flock` | `LOCK_EX` and `LOCK_UN` need a descriptor open for writing, or `CAP_SYS_ADMIN` | Open with `exec 9>>`, not `9<` |
| `EIO` from `flock -u` | The release didn't reach the device; the descriptor keeps the lock | Retry `flock -u` |
| `ETXTBSY` writing a file after `flock -u` on a default mount | This node suspended its lock for a handoff; its own writes are refused until `flock -x` takes it back | Expected: a handoff never has two writers |
| `EWOULDBLOCK` from `flock -x -n` on a default mount | The lock was suspended and another node has taken the file since | Expected after a handoff. Wait, or let the peer close the file |
| `EIO` from `close` | A write of the file's data failed earlier and nothing had reported it | Check the storage path; data written since the last successful `fsync` may not be on the device |
| `EIO` on one node for files with blocks in space another node just grew into | This node's device still has the old size. Nothing is marked damaged | [Rescan the device](/docs/how-tos/grow-volume/#2-make-every-node-see-the-larger-device) on this node |
| A create, rename or delete in one directory waits | A node that died held that directory's namespace lock | It goes ahead once the node is stale. If the holder is still alive, it fails with `EBUSY` after about 12 s. |
| `EINVAL` from `rename` | `RENAME_EXCHANGE` or `RENAME_WHITEOUT` | Not supported |

## Loading the module

| Symptom | Meaning | Next step |
|---|---|---|
| `modprobe`: `Key was rejected by service` | Secure Boot is enabled and the module's signing key isn't enrolled. Every DKMS-built module does this | [Enroll the DKMS key](/docs/how-tos/secure-boot/) on the node |
| `insmod`: `Required key not available` or `Key was rejected by service` | Secure Boot and a module you built yourself, which isn't signed | [Sign it](/docs/how-tos/secure-boot/#modules-you-build-yourself) |
| `unknown filesystem type 'cetrafs'` | The module isn't installed for this kernel, or the kernel refused to load it | `dkms status cetrafs`; install the headers for the running kernel. DKMS builds only for kernels 7.0 to 7.2. If it is installed, `modprobe cetrafs` shows why it won't load |
| `insmod`: unknown symbol `crc32c` | CRC32C is a separate module on this kernel | `modprobe libcrc32c`, or install the module and use `modprobe` |

## Mount failures

| Symptom | Meaning | Next step |
|---|---|---|
| `EBUSY` | The device has no atomic CAW and another node already has it mounted | Single-node only. [Check CAW](/docs/how-tos/check-caw/). |
| `EBUSY`, `is being repaired right now` in `dmesg` | An `fsck.cetra -r` or `growfs.cetra` is working on the volume | Wait for it to finish. A claim left by a killed tool is reaped once it is no longer renewed. |
| `EBUSY`, `another machine has the same node UUID` in `dmesg` | Two machines share a DMI UUID, typically cloned VMs | Give one its own identity: `options cetrafs node_uuid=<uuid>`. See [the Node Registry](/docs/concepts/coordination/#the-node-registry). |
| Refused, `node_uuid` named in `dmesg` | The firmware's DMI UUID is a placeholder, or there is no serial to tell machines apart | Set `node_uuid` on that machine |
| Mount takes minutes, `watching it … to be sure no other machine is using it` in `dmesg` | The first mount after an unclean shutdown watches its old registry row for the stale window, and may wait for a peer replaying its journal | Expected. If systemd kills the mount after 90 s, raise its [mount timeout](/docs/how-tos/mount-volume/#mount-at-boot-with-etcfstab) |
| Refused, block 0 doesn't verify | Something overwrote the superblock: a partition tool, a label, a `dd` at the wrong disk | [Restore it from the copy](/docs/how-tos/recover-node-failure/#the-mount-says-block-0-doesnt-verify) |
| `EBUSY`, `is already mounted without …` in `dmesg` | A second mount of a device this node already has mounted asks for a different `nofilelock`, `errors=` or `corruption=` setting | Use the first mount's options |
| `EINVAL`, version or feature in `dmesg` | The volume has another format version. 0.9.x volumes don't mount on 0.10. | [Upgrade by reformatting](/docs/how-tos/upgrade-reformat/) |
| `EINVAL`, file-lock mode conflict in `dmesg` | Your `nofilelock` option disagrees with the mode the cluster already uses | Use the same options as the other nodes |
| "CAW discovery failed … refusing the mount" | cetrafs couldn't determine whether the device supports compare-and-write | Check the storage path; the probe shows the error |
| Refused, page size in `dmesg` | A kernel with 16 KiB or 64 KiB pages | Use a 4 KiB-page kernel |
| Mounted read-only unexpectedly | An unknown read-only-compatible feature bit | Install the release that made the volume |
| Mounts, but `write_ready: no` | Every Zone Group is owned by a live peer | Persistent means fewer Zone Groups than writing nodes; `mkfs.cetra` now defaults to one per node |

## Tools

| Symptom | Meaning |
|---|---|
| `mkfs.cetra`, `growfs.cetra` or `fsck.cetra -r` exits `3` naming the device as busy | The device is mounted on this machine, possibly in another mount namespace (a container). Unmount it there. |
| `mkfs.cetra` exits `3` naming a live peer | Another node still has the volume mounted. `-f` won't override this. |
| `fsck.cetra --live` exits `3` | The volume changed too fast between walks to reach a verdict. Run it again when it is quieter. |
| `fsck.cetra -r` says a journal hasn't been replayed | Mount the volume once, unmount it, and run `-r` again |

## Messages in fsck output

| Message | Meaning |
|---|---|
| `N data block(s) marked in use but referenced by no inode (leaked)` | Normal after a node crash: blocks reserved ahead of need. The scrubber reclaims them; `-r` does it at once. |
| `WARN` lines about a deleted record's stale extents, a record never written, or an empty file no entry names | Leftovers of an interrupted operation, not damage; they don't change the exit code |
| `note:` about a free count behind its bitmap | A crashed owner's count, recounted by the next mount that takes over the Zone Group |
| Cross-file overlap, unreadable inode, dangling entry | `-r` refuses: these need a human decision. Keep the image, and report it. |
| A block referenced by a file but marked free | Never a crash leftover. Treat it as damage and report it. |

## Messages in the kernel log

| Message | Meaning |
|---|---|
| `fsck needed` at mount | A node found damaged metadata earlier. Run `fsck.cetra --live`, then `fsck.cetra -r` offline at the next window. |
| A warning that the superblock copy is stale or bad | The copy at block 2048 is damaged; the volume works. Run `fsck.cetra -r` at the next window to rewrite it. |
| `pending free LEAK` | A free couldn't be queued because the owner's queue was full. The scrubber reclaims the blocks. |
| A file passing half its extent tree's capacity | See [extents per file](/docs/reference/limits/#extents-per-file) |
| `retiring node N's entry …` | An operator retired a dead node's journal; each entry given up is named |

## Counters worth a second look

| Counter (in `info`) | Concerning when |
|---|---|
| `journal_replay_refused` | It rises with no recent failover. Find the block in `dmesg`. |
| `cas_miscompares` | It stays at 0 while two nodes are both busy (they may not share the device) |
| `scrub_reclaimed` / `scrub_cycles` | Leaks keep growing across crashes and `scrub_cycles` doesn't move |
| `bmap_crc_bad` | Any value above 0: a bitmap sector is damaged. Run `fsck.cetra -r` at the next window. |
| `discard_pending_bgs` | Stays above 0: UNMAPs with an unknown outcome. See [Return free space to a thin LUN](/docs/how-tos/reclaim-thin-space/#a-block-group-stuck-waiting-for-its-unmap). |
| `space_waits` | Rising: the array is out of space |
| `file_cache_drops` far above `file_cache_reconciles` | Files are stuck re-reading metadata from the device; I/O will be slow |

## Performance

| Symptom | Likely cause |
|---|---|
| Guest much slower than the host | `aio=io_uring`, qcow2, or writes into preallocated space. [Configure VM disks](/docs/how-tos/configure-vm-disks/). |
| `dd if=/dev/zero` in the guest returns instantly, then stalls | qemu `detect_zeroes` is dropping the writes; not the filesystem |
| Creates and deletes take hundreds of milliseconds | Expected: synchronous metadata over device round trips. [Performance model](/docs/concepts/performance/). |
| A large copy gets slower as it goes | Check `bg_pick_scan` and `bg_desc_refreshed`; report it with those numbers |

## Getting more information

- `dmesg | grep cetrafs`: errors and warnings are always logged.
- [Turn on debug logging](/docs/how-tos/debug-logging/) for a full trace.
- `cat /proc/fs/cetrafs/*/{info,cluster,properties}` from every node, as root.

{{< callout type="danger" >}}
Never `rmmod -f` cetrafs. A forced removal can leave a dangling entry in the kernel's memory-reclaim list that oopses the host on the next reclaim pass, and it persists until reboot. Unmount, then use plain `rmmod`.
{{< /callout >}}
