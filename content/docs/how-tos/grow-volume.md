---
weight: 367
title: "Grow a volume"
description: "Grow a cetrafs volume after its LUN has grown, or into space mkfs.cetra -s left unformatted, with growfs.cetra: live while it is mounted, or offline."
toc: true
---

A cetrafs volume can grow into space its device already has: a LUN you have enlarged on the array, or space that `mkfs.cetra -s` left unformatted. Nothing is copied and nothing existing moves. `growfs.cetra` adds new Block Groups after the existing ones.

Since 0.9.5 it can do that while the volume is mounted and in use. Offline growth, available since 0.9, still works.

{{< callout type="warning" title="One way, and every node upgraded first" >}}
- **A grown volume can't go back.** Modules and tools older than 0.9 refuse it, and there is no shrinking.
- **A live grow needs 0.9.5 on every node.** A node on 0.9 to 0.9.4 doesn't follow a live grow and won't notice the new space, and those modules pass the check `growfs.cetra` makes. Check the versions yourself.
{{< /callout >}}

## 1. Upgrade every node

Install the same `cetrafs-dkms` and `cetrafs-tools` on every node, and get the new module loaded: see [Upgrade](/docs/how-tos/upgrade-reformat/#from-092-to-093-094-and-095). Since 0.9.2 only format `0x0009` volumes mount. To keep a volume made by 0.8.x, grow it with 0.9.1, not 0.9.2: see [Upgrade](/docs/how-tos/upgrade-reformat/#from-08x-to-09x).

Then check every node:

```sh
cat /sys/module/cetrafs/version
grep -E 'caps=|live_grow_ready' /proc/fs/cetrafs/*/cluster
```

`live_grow_ready: yes` means every registered node has a module from 0.9 or later. It doesn't tell 0.9.5 from an earlier release, which is what the version above is for. A row with `caps=0x0` is a node still running a module older than 0.9, or one that hasn't mounted the volume since you upgraded it.

## 2. Make every node see the larger device

Grow the LUN on the array if you haven't. Then, on **every** node, have the kernel reread its size:

```sh
echo 1 > /sys/block/sdX/device/rescan          # each path of the LUN
multipathd resize map <alias-or-wwid>          # if it is multipathed
blockdev --getsize64 /dev/mapper/<alias-or-wwid>
```

For iSCSI, `iscsiadm -m session --rescan` rescans every session. All nodes must report the same new size.

If the space is already there, because you formatted with `mkfs.cetra -s`, skip this step.

## 3. Grow

### On a mounted volume

Run this on **any one node that has the volume mounted**. Guests keep running and, with the [Proxmox storage plugin](/docs/how-tos/proxmox-plugin/), the storage stays enabled.

```sh
growfs.cetra /dev/mapper/<alias-or-wwid> -n      # preview
growfs.cetra /dev/mapper/<alias-or-wwid>
```

The first line of the run says `growing it live`. Check the target size and the number of Block Groups added in the preview. To grow to less than the whole device, add `-s`, for example `-s 2T`. Space smaller than one Block Group (1 GiB by default) at the end of the device is left unused.

`growfs.cetra` writes the new Block Groups and their table segment past the current end, then hands the new superblock to the kernel. The kernel checks everything that was written before it publishes the grow. Mounts of the volume are refused with `EBUSY` while this runs.

The node that ran it sees the new size at once. Every other node picks it up on its next heartbeat, or as soon as it meets the new space. To confirm, compare `layout_gen` on each node, then check `df -h` or `pvesm status`:

```sh
grep layout_gen /proc/fs/cetrafs/*/info
```

The new Block Groups start unowned, and nodes claim them as they need space. See [Claiming and handing back Block Groups](/docs/concepts/allocation/#claiming-and-handing-back-block-groups).

`fsck.cetra` can't run on a mounted volume, so checking a live grow waits for your next maintenance window.

{{< callout type="note" title="What has been tested" >}}
A first live grow has passed on two nodes over a real compare-and-write LUN, while the other node was writing. Not yet run across nodes: a second grow, a node whose device hasn't been rescanned, and a VM streaming through the grow. Try it on a volume you can restore.
{{< /callout >}}

### On an unmounted volume

Stop or move the guests that use the volume, then unmount it on every node. With the Proxmox storage plugin, disable the storage first, or `pvestatd` mounts it again within seconds:

```sh
pvesm set san1 --disable 1          # once, from any node
umount /mnt/pve/san1                # on every node
```

On one node, preview, grow and verify:

```sh
growfs.cetra /dev/mapper/<alias-or-wwid> -n
growfs.cetra /dev/mapper/<alias-or-wwid>
fsck.cetra /dev/mapper/<alias-or-wwid>
```

Every node in the preview should read `ready`. Then mount on every node again, or re-enable the Proxmox storage with `pvesm set san1 --disable 0`, and check the new size with `df -h` or `pvesm status`.

The new Block Groups are shared out among the existing Zone Groups. A node that owns those Zone Groups can allocate from them at once. Space a node doesn't use and that is completely empty is handed back for other nodes to claim.

## If something goes wrong

- **`is mounted by another node`**: you ran it on a host that doesn't have the volume mounted while another node does. Run it on a node that has it mounted, or unmount it everywhere. A node that has crashed doesn't block the grow: `growfs.cetra` watches each registered node's heartbeat for a few seconds and refuses only while one is still beating.
- **`the added space is smaller than one Block Group`**: the device didn't grow by enough, or the node running `growfs.cetra` still sees the old size. Repeat step 2.
- **`a node in the cluster cannot follow a live grow`**: a registered node has a module older than 0.9. Upgrade it, or grow offline.
- **`the volume changed while this grow ran`**: nothing was published. Run it again.
- **`the kernel refused to publish the grow`**: see `dmesg`. Nothing was published unless it says the outcome is unknown.
- **`EIO` on one node, on files with blocks in the new space**: that node's device still has the old size, and `dmesg` says to rescan it. Nothing is marked damaged, and the files work as soon as you repeat step 2 on that node.
- **A node refuses to mount after the grow**: it runs a module older than 0.9. Upgrade it.

A crash or power cut during an offline grow leaves either the volume as it was before, or the grown volume. Run `fsck.cetra`, then `growfs.cetra` again if the volume didn't grow.

If a live grow is interrupted, the volume stays at its old size and keeps working. Run `growfs.cetra` again to finish. Such a stop can leave two marks, and neither is damage:

- `fsck.cetra` notes a table segment the superblock doesn't count yet. The next grow replaces it.
- `fsck.cetra` reports a Zone Group's `pool_free_blocks` too high, and `df` overstates free space by that much. Each interrupted attempt can add to it, until an offline `fsck.cetra -r` recounts it.

## Related

- [`growfs.cetra` reference](/docs/reference/growfs/)
- [`mkfs.cetra -s`](/docs/reference/mkfs/): leave room to grow into
- [Zone Groups and allocation](/docs/concepts/allocation/)
