---
weight: 230
title: "Build a Proxmox VE shared datastore"
description: "Put VM disk images on one shared LUN mounted by every node of a Proxmox VE cluster, then live-migrate a running VM."
toc: true
---

In this tutorial you turn a shared SAN LUN into a datastore for a Proxmox VE cluster. Every node mounts the same cetrafs volume, VM disks on it are visible everywhere, and running VMs can be live-migrated between nodes.

## What you need

- A **Proxmox VE cluster** on the `7.0.14-*-pve` kernel, with cetrafs installed on **every** node. See [Install on Proxmox VE](/docs/how-tos/install-proxmox/).
- A **shared LUN** visible to every node, here `<dev>`. This can be `/dev/sdb`, or, for a multipath LUN, a stable link such as `/dev/disk/by-id/dm-uuid-mpath-<wwid>`.
- The LUN must support **SCSI COMPARE AND WRITE (ATS)**.
- **Proxmox HA with fencing** configured, if you will run this in production. cetrafs relies on it to power off a host that has stopped responding (see [Fencing and split-brain](/docs/concepts/fencing/)).

We'll use `/mnt/cetra` as the mount point and `cetrafs` as the Proxmox storage ID.

{{< callout type="note" title="Doing it by hand, on purpose" >}}
This tutorial mounts the volume and registers it in Proxmox by hand, so you see each piece. For a cluster you will keep, the [storage plugin](/docs/how-tos/proxmox-plugin/) replaces steps 4 and 5: Proxmox then mounts the volume on every node itself, always with `nofilelock`, and you don't edit `/etc/fstab`.
{{< /callout >}}

{{< callout type="warning" >}}
`mkfs.cetra` erases the LUN. `mkfs` and `fsck` must run while the volume is **unmounted on every node**.
{{< /callout >}}

## 1. Confirm the LUN supports atomic CAW

On one node:

```sh
modprobe cetrafs caw_probe=<dev>
dmesg | grep 'caw probe'      # look for: max_caw_blocks=N (atomic CAW available)
rmmod cetrafs
```

`max_caw_blocks` of 1 or more means the LUN can back a multi-node cluster. If it reads `0`, the volume can only be mounted by one node at a time.

## 2. Check the path timers against the stale window

A node that can't renew its heartbeat stops itself after the stale window less one heartbeat: 105 s with the defaults. After the full stale window, 120 s, its peers take over its storage. So a write must never be held on its way to the array for longer than 105 s, or it could land on storage another node now owns.

A write can be held by the SCSI command timeout, then the transport (iSCSI's `replacement_timeout`, FC's `fast_io_fail_tmo`), then dm-multipath queueing (`no_path_retry × polling_interval`). Add them up for your array:

```sh
cat /sys/block/sdX/device/timeout                          # SCSI command timeout
multipath -t | grep -A 25 '<your array vendor string>'     # no_path_retry, polling_interval
```

If the sum reaches 105 s, shorten the timers or raise `stale_secs` on every node. The stock HPE 3PAR entry alone queues for 90 s, so on that array it usually means both. [Set the stale window for multipath](/docs/how-tos/multipath-stale-window/) has the details.

## 3. Create the volume, once, from one node

```sh
mkfs.cetra <dev>
```

The defaults are right for a large LUN. If `mkfs` exits with code `3`, some node still has the LUN mounted, and mkfs refuses to format a live cluster's volume even with `-f`.

## 4. Mount on every node with `nofilelock`

By default, cetrafs gives a file open for writing on one node exclusively to that node. Live migration needs the disk image open on the source *and* the destination during the handoff, so a Proxmox cluster mounts with `nofilelock`, which turns that automatic lock off.

Add the mount to `/etc/fstab` on **every** node:

```fstab
<dev>  /mnt/cetra  cetrafs  nofilelock,_netdev,nofail  0  0
```

Then mount it on every node:

```sh
mkdir -p /mnt/cetra
mount /mnt/cetra
grep file_lock /proc/fs/cetrafs/*/info     # file_lock: off
```

The lock mode applies to the whole cluster. The first node to mount sets it and the rest inherit it, and a node that asks for a conflicting mode is refused. Putting the same option in every node's `fstab` keeps them consistent whatever order they boot in.

{{< callout type="note" title="Who prevents double writes now?" >}}
With `nofilelock`, cetrafs no longer stops two nodes from writing the same image at once. Only Proxmox's cluster layer keeps writers apart: a VM belongs to one node, and HA fences a failed node before restarting its VMs. qemu's own image locking is turned off in Proxmox, so nothing protects an image from a writer outside Proxmox. See [why `nofilelock` exists](/docs/how-tos/live-migration/#why-proxmox-needs-it-image-locking-is-turned-off). cetrafs still makes the *sequential* handoff coherent: under `nofilelock` it reads each file's metadata fresh from the device, so the destination always sees the source's final state.
{{< /callout >}}

## 5. Register the storage in Proxmox

On any one node. Storage configuration is cluster-wide:

```sh
pvesm add dir cetrafs --path /mnt/cetra --content images,rootdir --shared 1 --is_mountpoint yes
```

`--shared 1` tells Proxmox that every node sees the same files. `--is_mountpoint yes` makes Proxmox refuse to use the directory when cetrafs is not mounted, so it never writes VM disks onto the node's root filesystem by mistake.

Check that every node sees the storage:

```sh
pvesm status | grep cetrafs
```

## 6. Create a VM with the right disk settings

Create a VM in the web UI or with `qm create`, with its disk on the `cetrafs` storage. Use these settings for the disk:

| Setting | Value | Why |
|---|---|---|
| Format | **raw** | qcow2 fragments badly on any extent-based filesystem |
| Cache | **None** (`cache=none`) | Direct I/O, Proxmox's default for shared storage and the path cetrafs is tuned for |
| Async IO | **threads** (`aio=threads`) | Measured 30% faster than `io_uring` on raw and more than 4× faster on qcow2 |
| Discard | **on** (`discard=on`) | A guest's TRIM frees space on the volume, and from there on a thin LUN |
| Preallocation | **off** | Thin images allocate in long contiguous runs and avoid the extent-conversion path |
| IO thread | on | Recommended for VirtIO SCSI single |

For example, for VM 100 with a 32 GiB disk:

```sh
qm set 100 --scsihw virtio-scsi-single --scsi0 cetrafs:32,format=raw,iothread=1,aio=threads,discard=on
```

The reasons and the measurements behind these settings are in [Configure VM disks for cetrafs](/docs/how-tos/configure-vm-disks/).

Start the VM and install a guest OS as usual.

## 7. Live-migrate the VM

While the VM runs on one node, migrate it to another:

```sh
qm migrate 100 <target-node> --online
```

Because the disk is on shared storage, only the VM's memory is copied. During the switchover qemu has the image open on both nodes for a moment, which `nofilelock` allows. Then the source closes it and the destination takes over. The guest keeps running.

## 8. Look at the datastore from any node

```sh
cat /proc/fs/cetrafs/*/cluster    # every node, its heartbeat, and whether it is stale
cat /proc/fs/cetrafs/*/info       # free space, Zone Group ownership, counters
```

## What you built

- One LUN, mounted on every Proxmox node and registered as **shared** directory storage.
- VMs whose disks live directly on cetrafs, using **raw + cache=none + aio=threads**.
- **Live migration** through `nofilelock`, with Proxmox's cluster layer and HA keeping writers apart.

## Next

- Compare this with the other ways to share a SAN between Proxmox nodes: [Shared storage for Proxmox VE without Ceph](/docs/concepts/proxmox-shared-storage/).
- Set up monitoring: [Monitor a volume](/docs/how-tos/monitor/).
- Plan for failures: [Recover from a node failure](/docs/how-tos/recover-node-failure/).
- Validate the stack before trusting it: [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/).
