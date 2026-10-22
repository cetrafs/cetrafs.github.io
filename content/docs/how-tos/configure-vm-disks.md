---
weight: 345
title: "Configure VM disks for cetrafs"
description: "Use raw images, cache=none, aio=threads and no preallocation for VM disks on cetrafs, and see what each setting is worth."
toc: true
---

These settings come from measurements on a Proxmox VE 7.0.14 cluster on HPE 3PAR storage over 32 Gb FC. They were taken on the same volume at the same time, with sequential 1 MiB `O_DIRECT` writes:

| Path | Throughput |
|---|---|
| Host writing straight to cetrafs | 550–600 MB/s |
| Guest, raw, `aio=io_uring` | 350 MB/s |
| Guest, raw, `aio=threads` | **~500 MB/s** |
| Guest, qcow2, `aio=io_uring` | 90 MB/s |
| Guest, qcow2, `aio=threads` | **~400 MB/s** |

## The short version

```sh
qm set <vmid> --scsi0 <storage>:<vmid>/<disk>,iothread=1,aio=threads
```

- **Format:** raw
- **Cache:** none (`cache=none`, which is `O_DIRECT`)
- **Async IO:** threads
- **Preallocation:** off
- **IO thread:** on, with the VirtIO SCSI single controller

## Set `aio=threads`

Proxmox defaults to `aio=io_uring` when the kernel supports it. On this stack (pve 7.0.14, direct I/O) that costs about 30% on raw images and more than 4× on qcow2. The host's own throughput is the same in every case, so the gap is in qemu's I/O submission, not in the filesystem.

In the web UI: **VM → Hardware → Hard Disk → Edit → Advanced → Async IO: threads**.

## Prefer raw images

qcow2 allocates in 64 KiB clusters and scatters them, so its backing file fragments badly. Under random guest I/O, a 32 GiB qcow2 image reached **28,659 extents**; an 8 GiB raw image had **16**. Every extent is metadata the filesystem has to store, look up and journal, and under `nofilelock` the defragmenter that could fix the fragmentation is off. Since 0.8, a lookup reads about 2 extent-tree blocks however fragmented the file is (it used to read every leaf until it found the block), but a raw image with a handful of extents is still the better choice.

If you must use qcow2, create it with 1 MiB clusters. That makes the L2 tables 16× smaller, so qemu's default L2 cache covers the whole image, and cuts fragmentation by about the same factor:

```sh
qemu-img create -f qcow2 -o cluster_size=1M /mnt/cetra/images/<vmid>/vm-<vmid>-disk-0.qcow2 32G
```

## Use `cache=none`

`cache=none` is Proxmox's default for shared storage and the path cetrafs is built for. `cache=writeback` and `cache=writethrough` work too, but they put the host page cache between the guest and the shared LUN.

## Turn preallocation off

Preallocated space is made of *uninitialized* extents: the blocks are reserved and read back as zeroes, and the first write to each one has to split the extent and convert it. That conversion path is the most complex write path in the filesystem, and it is where the bugs found during deployment testing were. With preallocation off, the allocator lays down long contiguous runs on first write instead: 16 extents for an 8 GiB image.

In the Proxmox storage config (`/etc/pve/storage.cfg`), set it for the whole cetrafs storage:

```ini
dir: cetrafs
    path /mnt/cetra
    content images,rootdir
    shared 1
    is_mountpoint yes
    preallocation off
```

## Benchmark with `detect_zeroes` off

With `detect_zeroes` on, qemu drops all-zero writes entirely. A `dd if=/dev/zero` inside the guest then measures qemu's zero detection rather than the storage: it returns at once, then stalls. That looks exactly like a filesystem fault and isn't one. Benchmark with real data (`/dev/urandom` written to a file first) or with `detect_zeroes` off.

## Related

- [Performance model](/docs/concepts/performance/)
- [Defragment a file](/docs/how-tos/defragment/)
