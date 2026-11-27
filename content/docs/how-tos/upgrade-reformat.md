---
weight: 375
title: "Upgrade cetrafs"
description: "Upgrade between releases of one on-disk format node by node, or move a volume to a new format version by evacuating, reformatting and restoring. 0.9.x to 0.10 is a format change."
toc: true
---

What an upgrade involves depends on whether the on-disk format version changes. The release notes say; so does `version` in [`properties`](/docs/reference/procfs/#properties).

| From | To | Format | What to do |
|---|---|---|---|
| 0.10.1 to 0.10.3 | {{< version >}} | `0x000A`, unchanged | [Node by node](#upgrading-within-a-format-version) |
| 0.9.x | {{< version >}} | `0x0009` → `0x000A` | [Evacuate, reformat and restore](#upgrading-across-a-format-change) |
| a release of one format | another release of the same format | unchanged | [Node by node](#upgrading-within-a-format-version) |

## Upgrading within a format version

Nodes running different builds, or different kernels, of one format version can share a volume. So an upgrade that keeps the format can be done one node at a time, with the VMs kept running on the others:

{{< steps >}}
1. Install the new `cetrafs-dkms` and `cetrafs-tools` on every node. Install the tools too, not just the module.
2. On one node: migrate its VMs away, unmount the volume, reload the module or reboot, and mount again.
3. Repeat on the next node.
{{< /steps >}}

A new `cetrafs-dkms` builds the new module, but a mounted volume keeps running the old one until it is unmounted and the module reloaded. Rebooting the node is the simplest way.

## Upgrading across a format change

A module of one format version doesn't mount a volume of another, and there is no in-place migration. Moving to a new format means evacuating the data, reformatting and restoring. **0.9.x to {{< version >}} is such a change**: 0.10 doesn't mount `0x0009` volumes, and 0.9.x doesn't mount `0x000A` ones.

{{< steps >}}
1. **Evacuate the data.** Move the VM disks to other storage, with `qm disk move` on Proxmox VE, `qemu-img convert`, or `cp --sparse=always`. Or make sure an array-level backup exists that you have tested restoring.
2. **Unmount the volume on every node.** With the [Proxmox storage plugin](/docs/how-tos/proxmox-plugin/), disable the storage first (`pvesm set <storage> --disable 1`), or `pvestatd` mounts it again within seconds.
3. **Install the new module and tools on every node**, and reload the module or reboot. Tools and module must come from the same release.
4. **Reformat with the new tools**, on one node: `mkfs.cetra <dev> -f`. Review the [new options](/docs/reference/mkfs/) first; `-A` sets the data alignment, and Zone Groups now default to one per node.
5. **Mount on every node** (or `pvesm set <storage> --disable 0`) and move the data back.
{{< /steps >}}

`cp --sparse=always`, `tar -S` and `qemu-img convert` all keep thin images thin through `SEEK_HOLE`/`SEEK_DATA`.

## Reclaiming space `fsck` can't recover

The same evacuate-and-reformat procedure applies to a volume carrying a leak that `fsck.cetra -r` can't reclaim.
