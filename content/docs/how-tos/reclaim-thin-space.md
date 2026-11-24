---
weight: 368
title: "Return free space to a thin LUN"
linkTitle: "Reclaim thin space"
description: "Give space freed in cetrafs back to a thin-provisioned LUN with UNMAP: automatically when a Block Group empties, with fstrim, or inline with -o discard, and pass guest TRIM through."
toc: true
---

On a thin-provisioned LUN, the array allocates space when it is first written and keeps it until it is told the space is free. cetrafs tells it with SCSI UNMAP (Linux calls it *discard*), in three ways:

| Mechanism | Default | What it returns |
|---|---|---|
| **Automatic** | On | A whole Block Group, unmapped as it goes back to the pool once it is empty: deleting a VM gives its space back without anyone doing anything. |
| **`fstrim`** | Run it yourself, or from a timer | Free space inside Block Groups still in use, for example holes a guest's TRIM punched in an image |
| **Inline**, `-o discard` | Off | The same space `fstrim` finds, about a second after it is freed, in the background |

All three need a device that takes discards. Check it on a mounted volume:

```sh
grep discard /proc/fs/cetrafs/<dev>/controls      # discard_supported: yes
```

On a device without discard nothing breaks: `fstrim` answers "not supported", and the automatic part does nothing.

## Automatic: emptied Block Groups

Nothing to do. When the last file in a Block Group goes, the group is unmapped and handed back to the pool, where any node can claim it. Each node does this for the Block Groups it owns.

A Zone Group the node has been writing into keeps its empty Block Groups for a grace period first, 150 seconds by default, so a long copy isn't handed back and claimed again every heartbeat. Once the node has left the Zone Group alone that long, its empty groups go back within a heartbeat or two. On a nearly full volume they go back at once. Change the grace per mount:

```sh
echo handback_grace=300 | sudo tee /proc/fs/cetrafs/<dev>/controls   # 30 to 1800 seconds
```

Longer smooths long copies further and keeps the space on this node longer. It never affects safety.

Turn it off on an array whose UNMAP is slow, with the `nodiscard` mount option, or on a live mount:

```sh
echo discard=off | sudo tee /proc/fs/cetrafs/<dev>/controls
```

## `fstrim`

```sh
sudo fstrim -v /mnt/cetra
```

`fstrim` trims only the Block Groups owned by the node it runs on, so **run it on every node**. It also visits the unowned pool, so groups handed back while discard was off get unmapped too. It runs alongside guest I/O; on an FC array, trimming 1 GiB of freed space took 1.5 s with fio running on both nodes.

A distribution's weekly `fstrim.timer` works as is. On a `nodiscard` mount, or with `discard=off`, `fstrim` answers "not supported" and sends nothing, so the timer doesn't send UNMAPs to an array they were turned off for.

## Inline: `-o discard`

```sh
sudo mount -t cetrafs -o discard <dev> /mnt/cetra
echo inline_discard=on | sudo tee /proc/fs/cetrafs/<dev>/controls    # or on a live mount
```

Each node unmaps what it frees in the Block Groups it owns, about a second after the free, batched in the background, never inside the operation that freed it. When the volume is out of space or being unmounted, queued runs are dropped rather than waited for; `fstrim` still finds them. `inline_discard_cmds`, `inline_discard_blocks` and `inline_discard_dropped` in [`info`](/docs/reference/procfs/#discard-and-space) show what it does.

Inline discard needs `discard` on as well; `nodiscard` turns both off.

## Let guest TRIM through

For space a guest frees to come back at all, the guest has to say so, and qemu has to pass it on:

- The VM disk needs `discard=on`. Proxmox defaults to `discard=ignore`: **VM → Hardware → Hard Disk → Edit → Discard**, or `qm set <vmid> --scsi0 <storage>:<disk>,discard=on`.
- The guest has to issue TRIM: `fstrim` in the guest, a periodic `fstrim.timer`, or the `discard` mount option in its own filesystem.

qemu turns guest TRIM into hole punches in the image, and cetrafs frees those blocks. The automatic mechanism, `fstrim` or `-o discard` then returns them to the array. A guest's write-zeroes requests become `ZERO_RANGE`, which cetrafs performs in place with WRITE ZEROES.

## Align the volume to the array

An array releases space in its own allocation units. An UNMAP that covers only part of a unit may release nothing. `mkfs.cetra -A` aligns every Block Group and its data to a multiple you choose, 1 MiB by default. If your array's UNMAP granularity is larger, set `-A` to it when you format: it can't be changed later. See [`mkfs.cetra`](/docs/reference/mkfs/#alignment).

## When an UNMAP fails

- **The array refuses it.** The blocks are freed anyway, and `discard_errors` in `info` counts it.
- **It fails in a way that might still execute**, such as a timeout or a path error. The blocks are held back rather than reused, because an UNMAP that lands late would erase whatever was written there next. `fstrim` counts them in `trim_leaked_blocks`, and the scrubber returns them once `trim_quarantine_secs` (default 600) have passed.

### A Block Group stuck waiting for its UNMAP

When the UNMAP of an emptied Block Group has an unknown outcome, the group is kept out of use, counted in `discard_pending_bgs`, and the UNMAP is sent again on every pass until one gets a definite answer. Turning `discard` off doesn't release it, because that doesn't cancel a command already sent.

If the device has stopped taking discards altogether, no answer ever comes. Once the paths have been reset, or the transport timers have run out, so that no earlier UNMAP can still land, release those groups on the node that owns their Zone Group:

```sh
echo release_discards=now | sudo tee /proc/fs/cetrafs/<dev>/controls
```

Every group held at that moment goes back on the next pass, untrimmed, and only if it is still empty. Said too early, an UNMAP still in flight lands on whatever is written there next.

## Related

- [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/)
- [Mount options](/docs/reference/mount-options/)
- [`controls` and `info`](/docs/reference/procfs/)
