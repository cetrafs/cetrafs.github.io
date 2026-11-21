---
weight: 535
title: "Limits and unsupported operations"
description: "Hard limits of the on-disk format, operations cetrafs deliberately does not support, the requirements a deployment must meet, and operational characteristics worth knowing."
toc: true
---

## Deployment requirements

| Requirement | Consequence if missing |
|---|---|
| Atomic SCSI COMPARE AND WRITE (ATS, opcode `0x89`) on the LUN, for more than one node | Volume is single-node only; a second mount fails with `EBUSY` |
| A whole disk or multipath device, not a partition, for more than one node | A partition is treated as having no compare-and-write, so it is single-node only: the command addresses the whole disk |
| An array cache that is non-volatile or write-through, and honours flushes | cetrafs orders metadata with cache flushes. An array that acknowledges a flush before the data is safe can lose that order in a power cut, and nothing on the host can detect it. |
| On a 512e LUN, compare-and-write atomic per 512-byte logical block | Two nodes routinely compare-and-write neighbouring sectors of one 4 KiB physical sector. Hardware arrays serialise that; test a software target before trusting it. |
| Path-failure timers below the stale window | A node whose I/O is held longer than the stale window can have its writes land after its peers took over. See [Set the stale window for multipath](/docs/how-tos/multipath-stale-window/). |
| An external cluster manager with host fencing (STONITH), for production multi-node use | A node that stalls but stays alive can keep writing what it had already queued after its peers have taken over. Without one, run single-node. |
| One on-disk format version on every node, and tools from the same release as the module | A module of another format version is refused at mount. Different builds and kernels of one format version can share a volume. |
| Supported kernel: `7.0.14`, `7.1.8+deb13`, `7.2.11`, Proxmox `7.0.14-*-pve` | DKMS builds for 7.0 to 7.2 only, and skips other kernels |
| A 4 KiB kernel page size: every amd64 kernel and nearly every arm64 one | The mount is refused on a kernel with 16 KiB or 64 KiB pages. `properties` shows `kernel_page_size`. |
| Little-endian host (amd64, arm64); one architecture per cluster | Big-endian hosts are untested |

## Hard limits

Limits of the on-disk format. Raising any of them needs a new format version.

| Limit | Value | Notes |
|---|---|---|
| Nodes per volume | **64** | The per-inode read-presence mask is 64 bits |
| File size | **1 EiB** (2<sup>48</sup> blocks) | 48-bit logical block numbers. A file can be larger than the volume it lives on, as on ext4, XFS and VMFS: space is used only as blocks are written. |
| Extents per file | **65,548,256** | A depth-3 extent tree. In practice this, not the size, is a file's limit; see [below](#extents-per-file). |
| Single extent | 8 TiB | 31-bit extent length |
| Directory size | **about 3.9 million entries** | 2<sup>18</sup> blocks of 15 entries |
| Zone Groups | **255** | Fixed at `mkfs`: a grow adds Block Groups, not Zone Groups |
| Block size | **4 KiB**, fixed | |
| Minimum Block Group size | 512 MiB | |
| Inodes | Default 1 per 4 MiB at `mkfs`, capped at 65,536; a grow adds more | Up to 1024 inode table segments. One inode per 4 KiB block. |
| Filename length | 255 bytes | |
| Extended attributes | One 4 KiB block per inode, about 12 attributes; name ≤ 64 bytes, value ≤ 256 bytes | |
| Volume span | **One block device** | No spanned or multi-extent volumes. A volume grows with its LUN. |

### Extents per file

Nothing merges two extents that aren't physically adjacent, so each scattered first write into a hole takes one extent, and one into preallocated space up to two. About 250 GiB of scattered 4 KiB first writes fills a file's tree; a preallocated image about a third of that. Past it, a write that needs a new extent fails with `ENOSPC` while the volume still has space; nothing in the file changes, and writes into space already mapped keep working.

The kernel log and `tree_half_full` in [`info`](/docs/reference/procfs/#integrity) announce a file passing half its capacity. The remedy is to copy the file, which lays it out again in long extents. Sequentially written images never come near it.

## Unsupported operations

Each returns a clean error. None of them silently does the wrong thing.

| Operation | Result | Notes |
|---|---|---|
| Special files (`mknod`: device nodes, FIFOs, sockets) | Not created | An on-disk record with such a mode is refused with `EUCLEAN` |
| POSIX ACLs (`setfacl`, `system.posix_acl_*`) | Not supported | Same choice as VMFS. SELinux works through `security.*` xattrs. |
| `fcntl` and OFD byte-range locks | `ENOLCK` on a default mount; node-local under `nofilelock` or `localposixlocks` | There are no cluster-wide byte-range locks. See [mount options](/docs/reference/mount-options/#fcntl-byte-range-locks). |
| `flock(LOCK_SH)` | `EOPNOTSUPP` | Exclusive-only |
| `flock(LOCK_EX)` or `LOCK_UN` on a descriptor not open for writing, without `CAP_SYS_ADMIN` | `EBADF` | See [mount options](/docs/reference/mount-options/#using-flock2) |
| `rename` with `RENAME_EXCHANGE` or `RENAME_WHITEOUT` | `EINVAL` | `RENAME_NOREPLACE` and plain rename are supported |
| `fallocate` with `COLLAPSE_RANGE` or `INSERT_RANGE` | `EOPNOTSUPP` | Allocation, `KEEP_SIZE`, `PUNCH_HOLE` and `ZERO_RANGE` are supported |
| Preallocating, or resizing, a file another node has open | `EOPNOTSUPP` for preallocation, `ETXTBSY` for a truncate | qemu and `posix_fallocate` fall back on `EOPNOTSUPP`. A resize to the current size succeeds. |
| Hole punch or `ZERO_RANGE` on a file another node has open | Zeroed in place with WRITE ZEROES, nothing freed | `EOPNOTSUPP` if the other node holds the file's lock, or the device has no WRITE ZEROES |
| A write that needs a new extent in a full extent tree, or a create in a full directory | `ENOSPC` | The kernel log names the file or directory |
| `O_TMPFILE` | Not supported | |
| `chattr` / `FS_IOC_SETFLAGS` (immutable, append-only, nodump) | Not supported | |
| `fsfreeze` (`FIFREEZE`) | `EOPNOTSUPP` | Freeze the VMs, or `sync`, before an array snapshot |
| Idmapped mounts | Refused by the kernel | |
| Hardlink to a directory | `EPERM` | A directory has exactly one parent |
| More than 2<sup>31</sup>−1 links to one inode | `EMLINK` | |
| Remounting `ro` ↔ `rw` | Refused | Unmount and mount again |
| A volume of another format version | Refused at mount | No in-place migration between format versions |

## Supported (sometimes asked)

- Regular files, directories, symlinks, hardlinks.
- `user.*`, `trusted.*` (listed only to `CAP_SYS_ADMIN`) and `security.*` extended attributes. cetrafs can serve as an overlayfs layer.
- `O_DIRECT`, `mmap` (shared and writable), `fsync`, truncate in both directions, `splice` and `sendfile`.
- `fallocate`: allocation (with or without `KEEP_SIZE`), `PUNCH_HOLE` and `ZERO_RANGE`. Preallocated space reads back as zeroes.
- `SEEK_HOLE` / `SEEK_DATA` and `FS_IOC_FIEMAP`, so `filefrag`, `cp --sparse`, `tar -S` and `qemu-img convert` see holes. Preallocated ranges are reported as unwritten.
- `FITRIM` (`fstrim`), and UNMAP of freed space. See [Return free space to a thin LUN](/docs/how-tos/reclaim-thin-space/).
- Timestamps in nanoseconds, and a birth time reported by `statx`.
- A volume UUID, reported as the filesystem UUID and in `statfs`'s `f_fsid`, the same on every node.
- qemu `cache=none`, `writeback` and `writethrough`. Across a live migration, use `cache=none`, which is what the handoff is tested with.

## Operational characteristics

- **A node can run out of space while the volume has room.** A node allocates only from the Block Groups it owns and from those nobody owns, and never takes space back from a live peer. A Block Group that is partly used stays with its owner. So on a nearly full volume, the node whose VMs grew can return `ENOSPC` while `df` on another node shows free space. `df`'s *available* figure on each node is what that node can allocate. Keep headroom per node, not just per volume, or move the VM to the node that has the space.
- **A free into another node's Zone Group can wait.** Deleting a file whose blocks another node owns queues the free to that node. If its queue is full, the blocks stay allocated (`pf_drop_runs` in `info`) until the scrubber reclaims them. Deleting from the owning node frees at once.
- **A crash while a directory moves to another parent can leave it unnamed.** The directory loses its old name before it gains the new one, because two names would be worse. `fsck.cetra -r` links it into `/lost+found`.
- **A write-protected LUN can't be mounted, even read-only.** A read-only mount still registers and heartbeats. An array snapshot exposed read-only must be made writable, or copied, to be mounted.
- **Metadata operations are synchronous** and cost real device round trips (a create takes about 400 ms on a typical iSCSI LUN). Data throughput isn't affected. See [Performance model](/docs/concepts/performance/).
- **Crash consistency is per `fsync`, not per syscall**, and mounting again repairs what a crash left. See [Journaling](/docs/concepts/journaling/).
- **Liveness is a timeout.** Default heartbeat 15 s, stale after 120 s, and a node that can't renew stops itself after 105 s.
- **A compare-and-write that times out is judged by a stamp** every swap moves. The one case it can't settle, a timeout followed by two other nodes' swaps of the same sector before the re-read, stops the mount instead of guessing. Keep the SCSI command timeout well inside the stale window.
