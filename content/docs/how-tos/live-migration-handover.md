---
weight: 341
title: "Live migration without nofilelock"
linkTitle: "Live migration without nofilelock"
description: "For integrators: live-migrate qemu VMs on a default cetrafs mount by handing each disk's lock from source to target, with every file still protected. The protocol, the qemu setup, failure handling and measured pauses."
toc: true
---

Live migration doesn't need `nofilelock`. On a default mount every file opened for writing is locked to one node, and a node can lend one file's lock to another for a moment and take it back. A management agent on each node can use that to move a running VM while every file on the volume stays protected, including the VM's own disks.

This page is for whoever writes that agent: a management layer, an orchestrator, or a future Proxmox. Proxmox VE can't do it today; see [Live migration on Proxmox VE](/docs/how-tos/live-migration/) for why.

## The building block

On a file this node has open for writing:

- **`flock(LOCK_UN)` suspends this node's lock** on that one file, with the file still open. The file is made durable first, as a close would. Another node can then open it for writing; opens for reading stay refused. This node's own writes to it fail with `ETXTBSY` until it takes the lock back.
- **`flock(LOCK_EX)` takes the lock back.** It never takes it from a node that holds it: with `LOCK_NB` it fails with `EWOULDBLOCK`, and without it waits. Once it has the lock, cetrafs rereads the file's metadata, so it sees what the other node wrote.
- **Closing the last write descriptor on a node releases the lock.**

The suspension belongs to the node and the file, not to one descriptor. So an agent that holds its own write descriptor of a disk file can lend and take back the lock qemu holds through *its* descriptors. qemu itself knows nothing about it. See [Handing one file's lock over](/docs/concepts/locking/#handing-one-files-lock-over-on-a-default-mount) for the full semantics.

## The handover

The agents run two exchanges around qemu's migration. The first gives the target its open descriptors; the second, at the switchover, gives it the lock.

```text
 source node                                 target node
 ───────────                                 ───────────
 qemu runs the guest; the agent holds
 a write descriptor of each disk file
                                    ◄─────  "lend me the disks"
 QMP stop                    (guest paused)
 flock(LOCK_UN) on each file
 "lent"                             ─────►
                                             open each file O_RDWR|O_DIRECT
                                             flock(LOCK_UN): lend the claim back
                                    ◄─────  "opened"
 flock(LOCK_EX) on each file
 QMP cont                   (guest resumes)
 "taken back"                       ─────►
                                             start qemu -incoming defer,
                                             disks passed as those descriptors
 migrate: RAM and device state      ─────►
 ...                                         ...
 migration completed, qemu exits;
 the agent closes its descriptors:
 the lock is released
 "gone"                             ─────►
                                             flock(LOCK_EX) on each file
                                             add the read-only descriptors
                                             QMP cont        (guest runs here)
```

Why each step is there:

| Step | Why |
|---|---|
| Pause the source guest while the lock is lent | Its writes fail with `ETXTBSY` meanwhile. With `werror=stop` the guest would stop on an I/O error instead. The pause lasts two round trips and a few opens, about 30 ms. |
| Open on the target before its qemu starts | The pause covers a few `open` calls, not a qemu start, which takes seconds. |
| Lend the target's claim back at once | Opening for writing takes the lock. `LOCK_EX` never takes it from a node that holds it, so the source couldn't get its files back otherwise. |
| The source's agent closes its descriptors with qemu's exit | Its own descriptor is a writer too. The lock goes when the last one closes. |
| Resume the target only once the source's qemu is gone | A hole punch is refused while another node has the file open, and qemu then turns discard off for the rest of the process's life. |

Backing files and other read-only layers are never write-locked, so both sides open them normally.

## Driving qemu

The target qemu must never open a disk file by path before the switchover: the open would be refused. Everything goes through descriptors the agent hands it.

- **Start it with `-incoming defer`**, then add the disks with `blockdev-add` and `device_add` over QMP, with `filename` set to `/dev/fdset/<N>`. The agent passes its `O_RDWR` descriptors into fd sets with `add-fd` (or `-add-fd` on the command line).
- **Turn qemu's own image locking off** with `"locking": "off"` on each `file` node. qemu locks with `fcntl` byte ranges, which a default cetrafs mount refuses with `ENOLCK`, so with `auto` or `on` the open fails with `Failed to lock byte`. Nothing is lost: those locks wouldn't reach other nodes, and cetrafs's own lock does the job.
- **Read-write descriptors only, until the switchover.** A read-only open is refused until the target holds the lock. A qemu waiting for incoming migration opens its images inactive and accepts an fd set that holds only a read-write descriptor. It needs a read-only one later, to reopen a layer read-only or to inactivate the image at its own next migration, so the agent opens one and adds it to the set once it has taken the lock.
- **No `qemu-img` on the target before the switchover.** `qemu-img info` opens the file and is refused. Read the size and the backing file name from the qcow2 header through the descriptors already open.
- **Shorten the switchover** with `migrate-set-parameters downtime-limit=100` (qemu's default is 300 ms), and announce the NICs after `cont` (`announce-self`). A guest with an emulated e1000 NIC doesn't announce itself after a migration and can be unreachable for many seconds; virtio does.

## Failures

| When | What happens |
|---|---|
| The target never answers "opened" | The source takes its files back after a timeout and resumes the guest. |
| The target dies after opening | Its descriptors close with it, its claim goes, and the source's `LOCK_EX` succeeds. |
| The source can't take a file back | Its guest stays paused, and the agent reports it. This only happens if the target holds on; it lends back at once. |
| The migration fails before the switchover | The target's qemu and descriptors close. The source held the lock all along. |
| The target can't take the lock at the switchover | The migration fails after the source has let go. The cluster restarts the VM, as for any failure after the switchover. |
| `flock(LOCK_UN)` returns `EIO` | The release didn't reach the device and the lock is still held. Abort the migration. |

## Measured

On a three-node cluster sharing an iSCSI LUN, with a Debian 13 guest (768 MiB, one virtio disk, one virtio NIC) on qemu 10.0:

| | Result |
|---|---|
| Guest pause at the handover | 28–57 ms over nine migrations, mostly 30–34 ms |
| Guest pause at the switchover | 101–154 ms, of which qemu's own downtime was about 50 ms and the target's `LOCK_EX` about 17 ms |
| Whole migration | 4.2–7.2 s |
| A ping from inside the guest every 50 ms | No packet lost, no gap over 150 ms |

## What Proxmox would need

Proxmox already drives a migration from both ends, over its own tunnel between the nodes, and starts the target qemu itself. To migrate on a default mount it would need to:

1. hold a write descriptor of each disk file on the node running the VM;
2. run the two exchanges above around its migration;
3. pass the target qemu its disks as descriptors instead of paths.

With that, `nofilelock` would have no remaining use, and every file on the volume would stay protected.

## Related

- [Live migration on Proxmox VE](/docs/how-tos/live-migration/)
- [Locking model](/docs/concepts/locking/)
