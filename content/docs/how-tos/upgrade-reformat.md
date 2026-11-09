---
weight: 375
title: "Upgrade to a new format version"
description: "Move a volume to a new cetrafs on-disk format by evacuating, reformatting and restoring. There is no in-place migration."
toc: true
---

cetrafs has **no on-disk backward compatibility** during the beta, with one temporary exception, described [below](#from-08x-to-09x). A format version change is otherwise a clean break: a volume whose format version, or an unknown *incompatible* feature bit, the module doesn't understand is refused at mount. An unknown *read-only-compatible* bit only forces a read-only mount.

Not every release changes the format. Check the release notes. A release that keeps the format only needs the module and tools updated on every node.

## Upgrading a release that keeps the format

1. Install the new `cetrafs-dkms` and `cetrafs-tools` on every node. Install the tools too, not just the module.
2. Node by node: migrate the VMs away, unmount, reload the module (or reboot), mount again.

Before you mix versions in one cluster, check that the release notes say the versions are compatible. The multi-node test suite assumes every node runs the same `cetrafs.ko` build.

## From 0.9.2 to 0.9.3, 0.9.4 and 0.9.5

0.9.3, 0.9.4 and 0.9.5 keep format `0x0009`, so a volume made or grown by an earlier `0x0009` release mounts as it is. 0.9.3 added one inode field, and 0.9.5 two Node Registry fields, in space that was zero padding on every existing record, so nothing has to be rewritten. One exception: since 0.9.5 a per-node journal larger than 16 GiB is refused at mount and by `fsck.cetra`, so a volume made with such a large `-J` has to be reformatted.

Two releases must not share a volume, though. Several fixes in each release change how nodes arbitrate with each other: who may open a file while another node reads it, and when blocks and inode numbers may be freed or reused. In 0.9.5 a scrub also stands aside while any node has frees in flight, which an older node neither announces nor honours. They protect only nodes that run them. So the rolling, node-by-node upgrade above doesn't apply this time:

{{< steps >}}
1. Install the new `cetrafs-dkms` and `cetrafs-tools` on every node.
2. Stop the VMs on the volume and **unmount it on every node**.
3. Reload the module (or reboot) on every node.
4. Mount again.
{{< /steps >}}

## From 0.8.x to 0.9.x

0.9 writes format `0x0009`. **0.9 and 0.9.1** also mount, check and grow `0x0008` volumes from 0.8.x, so moving to one of them needs no reformat: follow [Upgrading a release that keeps the format](#upgrading-a-release-that-keeps-the-format). An `0x0008` volume stays readable by 0.8.x until it is **grown**: [growing](/docs/how-tos/grow-volume/) stamps it `0x0009`, and from then on 0.8.x modules and tools refuse it.

**Since 0.9.2** that window is closed: only `0x0009` volumes mount. For an `0x0008` volume that was never grown, before installing 0.9.2:

- **if its device has room** for at least one more Block Group, [grow it](/docs/how-tos/grow-volume/) with 0.9.1, which stamps it `0x0009`; then upgrade as usual;
- **otherwise**, [reformat it](#upgrading-across-a-format-change).

A volume made or grown by 0.9 or 0.9.1 is already `0x0009` and needs nothing.

## Upgrading across a format change

{{< steps >}}
1. **Evacuate the data.** Move the VM images to other storage (`qm disk move`, `qemu-img convert`, or `cp --sparse=always`), or make sure an array-level backup exists that you have tested restoring.
2. **Unmount on every node.**
3. **Install the new module and tools on every node.** Tools and module must come from the same build.
4. **Reformat with the new tools:** `sudo mkfs.cetra <dev> -f`
5. **Mount on every node** and restore the data.
{{< /steps >}}

`cp --sparse=always`, `tar -S` and `qemu-img convert` all keep thin images thin through `SEEK_HOLE`/`SEEK_DATA`.

## Reclaiming space fsck can't recover

The same procedure applies to a volume carrying an old leak, from before a fix, that `fsck.cetra -r` can't reclaim.
