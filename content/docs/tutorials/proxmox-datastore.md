---
weight: 230
title: "Build a Proxmox VE shared datastore"
description: "Put VM disk images on one shared LUN mounted by every node of a Proxmox VE cluster, then live-migrate a running VM."
toc: true
---

In this tutorial you turn a shared SAN LUN into a datastore for a Proxmox VE cluster. Every node mounts the same cetrafs volume, VM disks on it are visible everywhere, and running VMs can be live-migrated between nodes.

## What you need

- A **Proxmox VE cluster** on the `7.0.14-*-pve` kernel, with cetrafs installed on **every** node. See [Install from Debian packages](/docs/how-tos/install-packages/).
- A **shared LUN** visible to every node, here `<dev>`. This can be `/dev/sdb`, or a multipath alias such as `/dev/mapper/mpatha`.
- The LUN must support **SCSI COMPARE AND WRITE (ATS)**.
- **Proxmox HA with fencing** configured, if you will run this in production. cetrafs relies on it to power off a host that has stopped responding (see [Fencing and split-brain](/docs/concepts/fencing/)).

We'll use `/mnt/cetra` as the mount point and `cetrafs` as the Proxmox storage ID.

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

## 2. Check multipath against the stale window

Skip this step only if the LUN has a single path.

When all paths to a host fail, dm-multipath **queues** I/O for `no_path_retry × polling_interval` seconds instead of failing it. The host's cetrafs heartbeat is queued along with everything else, so its peers stop seeing it. After the **stale window** (`stale_secs`, 120 s by default) the peers declare the host dead and reclaim its storage. If the host's queued writes are released after that, they land on storage another node now owns.

The rule is: **a host must give up on failed I/O before its peers give up on the host.** The stock HPE 3PAR entry queues for 90 s, which the 120 s default clears. Check what your array does:

```sh
multipath -t | grep -A 25 '<your array vendor string>'   # no_path_retry, polling_interval
```

If your queueing time is 120 s or more, raise `stale_secs` on every node, as described in [Set the stale window for multipath](/docs/how-tos/multipath-stale-window/).

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
With `nofilelock`, cetrafs no longer stops two nodes from writing the same image at once. Proxmox HA and qemu's own locking do that job, just as vSphere does on top of VMFS. cetrafs still makes the *sequential* handoff coherent: under `nofilelock` it reads each file's metadata fresh from the device, so the destination always sees the source's final state.
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
| Preallocation | **off** | Thin images allocate in long contiguous runs and avoid the extent-conversion path |
| IO thread | on | Recommended for VirtIO SCSI single |

For example, for VM 100 with a 32 GiB disk:

```sh
qm set 100 --scsihw virtio-scsi-single --scsi0 cetrafs:32,format=raw,iothread=1,aio=threads
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
- **Live migration** through `nofilelock`, with Proxmox HA and qemu preventing double writes.

## Next

- Set up monitoring: [Monitor a volume](/docs/how-tos/monitor/).
- Plan for failures: [Recover from a node failure](/docs/how-tos/recover-node-failure/).
- Validate the stack before trusting it: [Validate a storage stack before deployment](/docs/how-tos/validate-storage-stack/).
