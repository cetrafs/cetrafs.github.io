---
weight: 210
title: "Your first cetrafs volume"
description: "Build cetrafs, create a volume on a loop device, mount it, look inside, and check it with fsck. Needs one Linux host and about 15 minutes."
toc: true
---

In this tutorial you build cetrafs from source, create a volume on a throwaway loop device, and look at it from the inside. You won't need shared storage or a second host; a disk image file stands in for the LUN.

By the end you will have:

- loaded the cetrafs kernel module,
- formatted and mounted a volume,
- seen the live state cetrafs publishes in `/proc`,
- written a sparse file and an extended attribute,
- checked the volume with `fsck.cetra`.

{{< callout type="note" title="Before you start" >}}
You need a host running a **supported kernel** (`7.0.14` or `7.1.8+deb13`, including Proxmox VE `7.0.14-*-pve`) and root access. Use a test machine or VM. The tutorial touches only a disk image it creates, but it does load a kernel module.
{{< /callout >}}

## 1. Install the build dependencies

On Debian, Ubuntu or Proxmox VE:

```sh
sudo apt install build-essential linux-headers-$(uname -r) git attr
```

`linux-headers-$(uname -r)` must match the kernel you are running, because the module is built against it.

## 2. Get the source and build it

```sh
git clone <repo-url> cetrafs      # the public repository URL is coming soon
cd cetrafs
make
```

`make` builds both halves:

- `kmod/cetrafs.ko` is the kernel module.
- `userspace/mkfs.cetra`, `userspace/fsck.cetra` and `userspace/defrag.cetra` are the tools.

## 3. Load the module

```sh
sudo insmod kmod/cetrafs.ko
grep cetrafs /proc/filesystems
```

The second command prints `cetrafs`. The kernel now knows the filesystem type.

{{< callout type="tip" >}}
If `insmod` fails with an unknown `crc32c` symbol, your kernel ships CRC32C as a separate module. Run `sudo modprobe libcrc32c` once and retry.
{{< /callout >}}

## 4. Create a disk to format

Create a 4 GiB sparse image file and attach it as a loop device:

```sh
truncate -s 4G /var/tmp/cetra-tutorial.img
LOOP=$(sudo losetup --find --show /var/tmp/cetra-tutorial.img)
echo $LOOP
```

The last command prints the device name, for example `/dev/loop0`. The rest of the tutorial uses `$LOOP`, so keep this shell open.

## 5. Preview the layout, then format

`mkfs.cetra` can show what it *would* do without writing anything. Note that the device always comes **first**, before any options:

```sh
sudo ./userspace/mkfs.cetra $LOOP -n
```

The summary begins with `cetrafs mkfs (DRY-RUN)` and lists the geometry it chose:

- **ZGs**: the number of Zone Groups. These are the allocation regions that cluster nodes take ownership of.
- **BGs** and **BG size**: Block Groups, the data regions inside each Zone Group. On a disk this small, mkfs automatically shrinks Block Groups from 1 GiB to 512 MiB so less space is lost to rounding.
- **node_table**: the Node Registry, with room for 64 nodes by default.
- **journals**: one private journal area per node.

Now format it for real:

```sh
sudo ./userspace/mkfs.cetra $LOOP
echo "exit code: $?"
```

The summary now starts with `cetrafs mkfs completed`, and the exit code is `0`.

## 6. Mount it

```sh
sudo mkdir -p /mnt/cetra
sudo mount -t cetrafs $LOOP /mnt/cetra
sudo dmesg | grep cetrafs | tail
```

The kernel log shows the mount lifecycle, a handful of lines like these:

```text
cetrafs: CAW: class=none logical_block_size=512 max_caw_blocks=0 -> atomic CAS unavailable
cetrafs: node registration: claimed row 0 (...)
cetrafs: ZG claim: own 1 of N zone group(s) (...)
cetrafs: mounted OK: Z=..., B=..., bg_size=... blocks, data@..., node_id=0
```

The first line matters most. A loop device has no atomic COMPARE AND WRITE, so this volume is **single-node only**: if a second host tried to mount it while this one is mounted, the mount would be refused.

The mount did three things. It **registered** this host in the Node Registry, it **claimed one Zone Group** to allocate from, and it started a **heartbeat** that renews this host's registry row every 15 seconds.

## 7. Look at the live state

Every mounted volume has a directory under `/proc/fs/cetrafs/`, named after the kernel's name for the device (`loop0`, `sdb`, `dm-3`...):

```sh
DEV=$(basename $LOOP)
cat /proc/fs/cetrafs/$DEV/info | head -20
```

Find these fields in the output:

- `this_node_id: 0`: this host's row in the Node Registry.
- `write_ready: yes`: this node owns a Zone Group, so it can allocate.
- `file_lock: on`: the cross-node whole-file lock is active (the default).
- `free_data_blocks`: live free space, counted in 4 KiB blocks.

Now look at the cluster view:

```sh
cat /proc/fs/cetrafs/$DEV/cluster
```

There is a single row, which is you. On a real cluster each mounted node has a row with its heartbeat counter (`hb_seq`) and whether this node considers it stale.

Finally, the device's coordination capability:

```sh
grep caw /proc/fs/cetrafs/$DEV/properties
```

On a loop device the line says `available=no`. A real SAN LUN that supports SCSI ATS reports `available=yes`, and only such a device can be mounted by more than one host.

## 8. Use it like a filesystem

cetrafs is a normal POSIX filesystem from the point of view of a single host:

```sh
sudo mkdir /mnt/cetra/images
echo "hello" | sudo tee /mnt/cetra/images/note.txt
sudo ln -s note.txt /mnt/cetra/images/link.txt
sudo setfattr -n user.owner -v tutorial /mnt/cetra/images/note.txt
getfattr -d /mnt/cetra/images/note.txt
```

Now create a **sparse** 2 GiB disk image, the way a thin VM disk starts out:

```sh
sudo truncate -s 2G /mnt/cetra/images/disk.raw
ls -lh /mnt/cetra/images/disk.raw     # apparent size: 2.0G
du -h  /mnt/cetra/images/disk.raw     # allocated: 0
```

Write 64 MiB into the middle of it with direct I/O, the way qemu writes with `cache=none`:

```sh
sudo dd if=/dev/urandom of=/mnt/cetra/images/disk.raw bs=1M count=64 seek=512 conv=notrunc oflag=direct
du -h /mnt/cetra/images/disk.raw      # allocated: 64M
sudo filefrag -v /mnt/cetra/images/disk.raw
```

`filefrag` reads the file's extent map through `FIEMAP` and shows a single extent, with holes on either side. Tools like `cp --sparse=auto` and `qemu-img convert` use the same interface to keep thin images thin.

Check free space as the kernel sees it:

```sh
df -h /mnt/cetra
```

## 9. Unmount and check

`fsck.cetra` refuses to run on a mounted volume, so unmount first:

```sh
sudo umount /mnt/cetra
sudo ./userspace/fsck.cetra $LOOP
echo "exit code: $?"
```

`fsck` runs four passes (structural, cluster metadata, content, namespace) and exits `0`, meaning clean.

## 10. Clean up

```sh
sudo losetup -d $LOOP
sudo rmmod cetrafs
rm /var/tmp/cetra-tutorial.img
```

{{< callout type="warning" >}}
Never use `rmmod -f` on cetrafs. A plain `rmmod` refuses while a volume is mounted, and that refusal is protecting you.
{{< /callout >}}

## What you learned

- cetrafs is a kernel module plus three tools. `mkfs.cetra` lays out Zone Groups, Block Groups, a Node Registry and per-node journals.
- Mounting **registers** the host, **claims** a Zone Group and starts a **heartbeat**.
- The live state is in `/proc/fs/cetrafs/<dev>/`.
- A device without COMPARE AND WRITE, such as this loop device, is single-node only.

## Next

- To see more than one node share a volume, continue with [A two-node cluster on a shared LUN](/docs/tutorials/two-node-cluster/).
- To understand what you just saw, read [Architecture overview](/docs/concepts/architecture/).
