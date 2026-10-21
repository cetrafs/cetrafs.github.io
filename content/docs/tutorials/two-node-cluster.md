---
weight: 220
title: "A two-node cluster on a shared LUN"
description: "Mount one LUN on two hosts and watch cetrafs coordinate them: registration, Zone Group ownership, the cross-node file lock, and recovery from a crashed node."
toc: true
---

In this tutorial two hosts mount the same LUN at the same time. You will see how they find each other, divide the disk between them, keep each other out of files that are in use, and recover when one of them dies.

{{< callout type="danger" title="Use a scratch LUN" >}}
This tutorial **formats** the LUN and, in the last part, crashes one of the hosts on purpose. Use a LUN that holds nothing you need and test hosts that run nothing else.
{{< /callout >}}

## What you need

- Two hosts, called **node A** and **node B** here, both on a [supported kernel](/docs/intro/status/#supported-platforms), with cetrafs installed. If you haven't installed it, follow [Install from Debian packages](/docs/how-tos/install-packages/) or [Build and install from source](/docs/how-tos/build-from-source/) on both hosts.
- One iSCSI or Fibre Channel LUN that **both** hosts can see. This tutorial calls it `/dev/sdb`; use your own device path, which can be a multipath alias such as `/dev/mapper/mpatha`.
- The LUN must support SCSI COMPARE AND WRITE. You will check that in the first step.

Commands are labelled with the host they run on.

## 1. Confirm the LUN can coordinate a cluster

On **node A**, run a capability probe. It reads the device's capabilities, writes nothing and mounts nothing:

```sh
# node A
sudo modprobe cetrafs caw_probe=/dev/sdb
sudo dmesg | grep 'caw probe'
sudo rmmod cetrafs
```

You should see something like this:

```text
cetrafs: caw probe: /dev/sdb -> class=scsi logical_block_size=512 max_caw_blocks=1 (atomic CAW available)
```

`max_caw_blocks=1` or higher means the array performs atomic compare-and-write, and that is what lets two hosts share the volume safely. If it reads `0`, stop here: this LUN can only ever be mounted by one host at a time. See [Check a LUN for atomic CAW](/docs/how-tos/check-caw/).

## 2. Format the volume once

Format from **one** host only:

```sh
# node A
sudo mkfs.cetra /dev/sdb
```

## 3. Mount on node A

```sh
# node A
sudo mkdir -p /mnt/cetra
sudo mount -t cetrafs /dev/sdb /mnt/cetra
cat /proc/fs/cetrafs/sdb/cluster
```

There is one row, marked `(this node)`:

```text
node 0: state=REGISTERED uuid=... hb_seq=1 last_seen=... label=node-a stale=no (this node)
```

The procfs directory is named after the kernel's device name (`sdb`). For a multipath device it is the `dm-N` name; `ls /proc/fs/cetrafs/` will show it.

## 4. Mount on node B

```sh
# node B
sudo mkdir -p /mnt/cetra
sudo mount -t cetrafs /dev/sdb /mnt/cetra
cat /proc/fs/cetrafs/sdb/cluster
```

Now there are **two** rows. Node B registered itself in the next free row of the Node Registry, using a compare-and-write on the LUN. No network message passed between the hosts.

Run the same `cat` on node A a few times. Node B's `hb_seq` increases every 15 seconds: that is its heartbeat, written to the shared disk and read by node A.

## 5. See how the disk is divided

On either node:

```sh
grep ' zg ' /proc/fs/cetrafs/sdb/info
```

Each line is one Zone Group, with its `owner`. Node A owns one and node B owns a different one. Each node allocates new blocks only from the Zone Groups it owns, so the two hosts never compete for the same free space. A node claims another Zone Group only when the ones it has are full.

## 6. Share the namespace

```sh
# node A
sudo mkdir /mnt/cetra/images
echo "written on A" | sudo tee /mnt/cetra/images/hello.txt
```

```sh
# node B
ls -l /mnt/cetra/images/
cat /mnt/cetra/images/hello.txt
```

Node B sees the directory and file right away, because cetrafs reads directory blocks fresh from the device. Every namespace change on either node is written straight to the device.

## 7. Watch the whole-file lock

By default cetrafs gives one node **exclusive** access to a file while that node has it open for writing. This is how VMFS protects a running VM's disk.

On **node A**, open a file for writing and keep it open:

```sh
# node A
sudo truncate -s 1G /mnt/cetra/images/vm-disk.raw
sudo bash -c 'exec 9>>/mnt/cetra/images/vm-disk.raw; echo "holding the file open; press Enter to release"; read'
```

While node A is waiting, try the file from **node B**:

```sh
# node B
sudo head -c 16 /mnt/cetra/images/vm-disk.raw
```

```text
head: cannot open '/mnt/cetra/images/vm-disk.raw' for reading: Text file busy
```

Node B can't even open the file for reading. Deleting it is refused too:

```sh
# node B
sudo rm /mnt/cetra/images/vm-disk.raw
```

Now press **Enter** on node A to close the file, and run the `head` on node B again. It succeeds this time.

The lock is a field in the file's inode record on the LUN. Node A set it with a compare-and-write when it opened the file, and cleared it when it closed the file.

{{< callout type="note" >}}
Live VM migration needs the image open on *both* hosts for a moment, which this lock forbids. Proxmox clusters therefore mount with `-o nofilelock`. The next tutorial does that, and [Locking model](/docs/concepts/locking/) explains the trade-off.
{{< /callout >}}

## 8. See contention being resolved

```sh
# either node
grep -E 'cas_ops|cas_miscompares' /proc/fs/cetrafs/sdb/info
```

`cas_miscompares` counts compare-and-writes that the array rejected because the other node had changed the record first. Each one was retried with fresh data. A number above zero after the steps above shows that the two hosts really did contend, and that the array resolved it.

## 9. Lose a node

This part shows what happens when a host dies while it holds resources.

On **node B**, open a file for writing (this takes its lock), then crash the host without a clean unmount:

```sh
# node B
sudo bash -c 'exec 9>>/mnt/cetra/images/vm-disk.raw; sleep infinity' &
sleep 2
echo b | sudo tee /proc/sysrq-trigger     # immediate reboot, no unmount
```

On **node A**, try to open the file right away:

```sh
# node A
sudo head -c 16 /mnt/cetra/images/vm-disk.raw    # Text file busy
```

The lock is still held by node B's row, and node A cannot yet tell whether node B is dead or only slow. Watch the cluster view:

```sh
# node A
watch -n 5 cat /proc/fs/cetrafs/sdb/cluster
```

Node B's `hb_seq` stops increasing. After the **stale window** (120 seconds by default) its row shows `stale=yes`. From then on, node A is allowed to reclaim what node B held. It replays node B's journal first, to finish any metadata write node B was in the middle of, then takes over node B's locks and Zone Groups as it needs them.

Try the file again:

```sh
# node A
sudo head -c 16 /mnt/cetra/images/vm-disk.raw    # succeeds
```

When node B comes back up, mount it again. It re-attaches to its old registry row and rejoins the cluster:

```sh
# node B
sudo mount -t cetrafs /dev/sdb /mnt/cetra
cat /proc/fs/cetrafs/sdb/cluster
```

{{< callout type="warning" title="Why production needs fencing" >}}
Node A waited 120 seconds because, from the shared disk alone, a dead host and a host that is only frozen look the same. If node B had come back to life after being declared dead, it would have found its lease revoked and **fenced itself**: every write fails with `EIO` until it remounts. Writes it already had in flight could still reach the disk, though. That is why a production cluster also needs a manager that can power off a host. See [Fencing and split-brain](/docs/concepts/fencing/).
{{< /callout >}}

## 10. Check the volume

Unmount on **both** nodes, then check from one of them:

```sh
# node A and node B
sudo umount /mnt/cetra
```

```sh
# node A
sudo fsck.cetra /dev/sdb
```

After a crash, `fsck` may report a few blocks as *leaked*. These are blocks node B had reserved ahead of need and never got to hand back. They are harmless: the background scrubber reclaims them, or you can reclaim them at once with `fsck.cetra -r`. See [Check and repair a volume](/docs/how-tos/check-and-repair/).

## What you learned

- Hosts register in a shared **Node Registry** and prove they are alive with an on-disk **heartbeat**.
- The disk is split into **Zone Groups**, and each node allocates only from its own.
- A file open for writing on one node is **locked** against every other node.
- All of this coordination runs through **compare-and-write** on the LUN. No cluster network is involved.
- A dead node's resources are reclaimed after the **stale window**, and its journal is replayed first.

## Next

- Put real VMs on it: [Build a Proxmox VE shared datastore](/docs/tutorials/proxmox-datastore/).
- Understand the mechanisms: [Cluster coordination](/docs/concepts/coordination/).
